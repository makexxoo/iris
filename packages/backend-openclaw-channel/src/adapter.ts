import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type {
  BackendRequest,
  InboundReplyMessage,
  ReplyTimeoutContext,
  UnknownReplyContext,
} from '@agent-iris/core';
import { SessionStateManager, WebSocketSessionBackend } from '@agent-iris/core';

const logger = pino({ name: 'backend-openclaw' });

export interface OpenclawChannelConfig {
  /**名称，用于区分多个openclaw*/
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 60000) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/openclaw). Set explicitly when running multiple WS backends. */
  wsPath?: string;
}

/**
 * Backend adapter that connects to openclaw via a persistent WebSocket.
 *
 * iris runs the WS server; the openclaw iris-channel plugin is the WS client.
 * This means iris is reachable even behind NAT — openclaw initiates the connection.
 *
 * Protocol:
 *   iris → openclaw (WS): { type: 'message', id, channel, channelUserId, sessionId, content, timestamp, context, history }
 *   openclaw → iris (WS): { type: 'reply', sessionId, text }
 *
 * chat() blocks until the reply arrives or the timeout fires.
 */
export class OpenclawChannelBackend extends WebSocketSessionBackend {
  name = 'openclaw';

  constructor(
    private config: OpenclawChannelConfig,
    sessionStates: SessionStateManager,
  ) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    super(timeoutMs, sessionStates, config.wsPath ?? "'/ws/openclaw'");
    this.name = config.name ?? 'openclaw';
  }

  /**
   * Attach this backend's WS handler to an existing HTTP server.
   * Call this after the Fastify server is created, before listen().
   */
  attach(httpServer: Server<typeof IncomingMessage>): void {
    this.attachWs(httpServer, this.path);
  }

  protected buildOutboundPayload(req: BackendRequest): string {
    const { message } = req;
    return JSON.stringify({
      type: 'message',
      id: message.id,
      channel: message.channel,
      channelUserId: message.channelUserId,
      sessionId: message.sessionId,
      content: message.content,
      timestamp: message.timestamp,
      context: req.context,
    });
  }

  protected parseInboundMessage(raw: string): InboundReplyMessage | null {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || typeof msg !== 'object') return null;
    const payload = msg as Record<string, unknown>;
    const type = payload['type'];
    const sessionId = payload['sessionId'];
    if ((type !== 'reply' && type !== 'reply_update') || typeof sessionId !== 'string') return null;
    return {
      type,
      sessionId,
      content: {
        type: 'text',
        text: typeof payload['text'] === 'string' ? (payload['text'] as string) : '',
      },
    };
  }

  protected noConnectionErrorMessage(): string {
    if (!this.isWsAttached()) {
      return 'openclaw-channel: WS server not attached — call attach() before sending messages';
    }
    return 'openclaw-channel: no connected openclaw instances — is the openclaw iris plugin running?';
  }

  protected async onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void> {
    const { sessionId, message, channelAdapter } = ctx;
    logger.warn({ sessionId }, 'openclaw-channel: reply timeout');
    try {
      await channelAdapter.reply({
        ...message,
        timestamp: Date.now(),
        content: { type: 'text', text: `openclaw: reply timeout for session ${sessionId}` },
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'failed to send timeout reply');
    }
  }

  protected onUnknownReply(ctx: UnknownReplyContext): void {
    logger.warn({ sessionId: ctx.sessionId }, 'received reply for unknown session');
  }

  close(): void {
    this.closeWs();
  }
}
