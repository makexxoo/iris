import Fastify from 'fastify';
import { ChannelAdapter } from './channels/types';
import { MessageEngine } from './engine';

export function createServer(channels: ChannelAdapter[], router?: MessageEngine) {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ status: 'ok' }));

  for (const channel of channels) {
    channel.register(server);
  }

  if (router) {
    /**
     * POST /v1/reply
     * Legacy HTTP callback for AI reply delivery (superseded by WS in openclaw-channel).
     * Kept for compatibility with any non-WS integrations.
     * Body: { sessionId: string, text: string }
     */
    server.post('/v1/reply', async (req, reply) => {
      const { sessionId, text } = req.body as { sessionId?: string; text?: string };
      if (!sessionId || typeof text !== 'string') {
        return reply.status(400).send({ error: 'sessionId and text are required' });
      }
      // Deliver asynchronously — don't block the response
      router.deliverReply(sessionId, text).catch((err: unknown) => {
        server.log.error(err, 'v1/reply: delivery error');
      });
      return { ok: true };
    });

    /**
     * POST /v1/outbound
     * Called by openclaw's outbound adapter to proactively send a message to a user.
     * Body: { sessionId: string, text: string }
     */
    server.post('/v1/outbound', async (req, reply) => {
      const { sessionId, text } = req.body as { sessionId?: string; text?: string };
      if (!sessionId || typeof text !== 'string') {
        return reply.status(400).send({ error: 'sessionId and text are required' });
      }
      router.deliverReply(sessionId, text).catch((err: unknown) => {
        server.log.error(err, 'v1/outbound: delivery error');
      });
      return { ok: true };
    });
  }

  return server;
}
