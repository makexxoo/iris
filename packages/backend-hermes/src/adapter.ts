import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type { BackendAdapter, BackendRequest, MessageContent } from '@agent-iris/core';

const logger = pino({ name: 'backend-hermes' });

export interface HermesBackendConfig {
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/hermes) */
  path?: string;
}

interface PendingReply {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Backend adapter that connects to the hermes-agent plugin (plugin-hermes) via WebSocket.
 *
 * iris runs the WS **server**; plugin-hermes is the WS **client**.
 * This mirrors the openclaw-channel and claude-code-channel pattern exactly.
 *
 * Protocol:
 *   iris → plugin (WS): { type: 'message', id, channel, channelUserId, sessionId, content, timestamp, context }
 *   plugin → iris (WS): { type: 'reply', sessionId, text }
 */
export class HermesBackend implements BackendAdapter {
  private wss: WebSocketServer | null = null;
  private connections = new Set<WebSocket>();
  private pending = new Map<string, PendingReply>();
  private readonly timeoutMs: number;
  private readonly path: string;

  name = 'hermes';

  constructor(config: HermesBackendConfig) {
    this.name = config.name ?? 'hermes';
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.path = config.path ?? '/ws/hermes';
  }

  /** Attach the WS handler to an existing HTTP server. Call before listen(). */
  attach(httpServer: Server<typeof IncomingMessage>): void {
    this.wss = new WebSocketServer({ server: httpServer, path: this.path });

    this.wss.on('connection', (ws) => {
      logger.info('plugin-hermes connected');
      this.connections.add(ws);

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('close', () => {
        logger.info('plugin-hermes disconnected');
        this.connections.delete(ws);
      });

      ws.on('error', (err) => {
        logger.warn({ err }, 'plugin-hermes WS error');
        this.connections.delete(ws);
      });
    });

    logger.info({ path: this.path }, 'hermes WS handler attached');
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

    if (!this.wss) {
      throw new Error('hermes: WS server not attached — call attach() before sending messages');
    }

    let targetWs: WebSocket | null = null;
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        targetWs = ws;
        break;
      }
    }

    if (!targetWs) {
      throw new Error('hermes: no connected plugin-hermes instance — is it running?');
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

    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        reject(new Error(`hermes: reply timeout for session ${sessionId}`));
      }, this.timeoutMs);

      this.pending.set(sessionId, { resolve, reject, timer });

      (targetWs as WebSocket).send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(sessionId);
          reject(new Error(`hermes: failed to send message: ${err.message}`));
        }
      });
    });
    return { type: 'text', text };
  }

  close(): void {
    this.wss?.close();
  }
}
