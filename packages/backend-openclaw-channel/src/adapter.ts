import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import { BackendAdapter, BackendRequest, MessageContent } from '@agent-iris/core';

const logger = pino({ name: 'backend-openclaw' });

export interface OpenclawChannelConfig {
  /**名称，用于区分多个openclaw*/
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 60000) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/openclaw). Set explicitly when running multiple WS backends. */
  path?: string;
}

interface PendingReply {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
export class OpenclawChannelBackend implements BackendAdapter {
  private wss: WebSocketServer | null = null;
  private connections = new Set<WebSocket>();
  private pending = new Map<string, PendingReply>();
  private readonly timeoutMs: number;
  private readonly path: string;

  name = 'openclaw';

  constructor(private config: OpenclawChannelConfig) {
    this.name = config.name ?? 'openclaw';
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.path = config.path ?? '/ws/openclaw';
  }

  /**
   * Attach this backend's WS handler to an existing HTTP server.
   * Call this after the Fastify server is created, before listen().
   */
  attach(httpServer: Server<typeof IncomingMessage>): void {
    this.wss = new WebSocketServer({ server: httpServer, path: this.path });

    this.wss.on('connection', (ws) => {
      logger.info('openclaw plugin connected');
      this.connections.add(ws);

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('close', () => {
        logger.info('openclaw plugin disconnected');
        this.connections.delete(ws);
      });

      ws.on('error', (err) => {
        logger.warn({ err }, 'openclaw plugin WS error');
        this.connections.delete(ws);
      });
    });

    logger.info({ path: this.path }, 'openclaw WS handler attached');
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const { type, sessionId, text } = msg as Record<string, unknown>;

    if (type === 'reply' && typeof sessionId === 'string' && typeof text === 'string') {
      const pending = this.pending.get(sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(sessionId);
        pending.resolve(text);
      } else {
        logger.warn({ sessionId }, 'received reply for unknown session');
      }
    }
  }

  async chat(req: BackendRequest): Promise<MessageContent> {
    const { message } = req;
    const sessionId = message.sessionId;

    // Find the first open connection
    let targetWs: WebSocket | null = null;
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        targetWs = ws;
        break;
      }
    }

    if (!this.wss) {
      throw new Error(
        'openclaw-channel: WS server not attached — call attach() before sending messages',
      );
    }

    if (!targetWs) {
      throw new Error(
        'openclaw-channel: no connected openclaw instances — is the openclaw iris plugin running?',
      );
    }

    const payload = JSON.stringify({
      type: 'message',
      id: message.id,
      channel: message.channel,
      channelUserId: message.channelUserId,
      sessionId,
      content: message.content,
      timestamp: message.timestamp,
      context: req.context,
    });

    const replyText = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        reject(new Error(`openclaw: reply timeout for session ${sessionId}`));
      }, this.timeoutMs);

      this.pending.set(sessionId, { resolve, reject, timer });

      (targetWs as WebSocket).send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(sessionId);
          reject(new Error(`openclaw-channel: failed to send message: ${err.message}`));
        }
      });
    });
    return { type: 'text', text: replyText };
  }

  close(): void {
    this.wss?.close();
  }
}
