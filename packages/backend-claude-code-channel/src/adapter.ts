import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type { BackendAdapter, BackendRequest } from '@agent-iris/core';

const logger = pino({ name: 'backend-claude-code' });

export interface ClaudeCodeChannelConfig {
  /** Name used for routing in MessageEngine (default: 'claude-code') */
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/claude-code) */
  path?: string;
}

interface PendingReply {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Backend adapter that connects to a claude-code-channel CLI via WebSocket.
 *
 * iris runs the WS server; the claude-code-channel CLI is the WS client.
 *
 * Protocol (identical to openclaw-channel):
 *   iris → CLI: { type: 'message', id, channel, channelUserId, sessionId, content, timestamp, context }
 *   CLI → iris: { type: 'reply', sessionId, text }
 */
export class ClaudeCodeChannelBackend implements BackendAdapter {
  private wss: WebSocketServer | null = null;
  private connections = new Set<WebSocket>();
  private pending = new Map<string, PendingReply>();
  private readonly timeoutMs: number;
  private readonly path: string;

  name = 'claude-code';

  constructor(private config: ClaudeCodeChannelConfig) {
    this.name = config.name ?? 'claude-code';
    this.timeoutMs = config.timeoutMs ?? 900_000;
    this.path = config.path ?? '/ws/claude-code';
  }

  /** Attach the WS handler to an existing HTTP server. Call before listen(). */
  attach(httpServer: Server<typeof IncomingMessage>): void {
    this.wss = new WebSocketServer({ server: httpServer, path: this.path });

    this.wss.on('connection', (ws) => {
      logger.info('claude-code-channel CLI connected');
      this.connections.add(ws);

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('close', () => {
        logger.info('claude-code-channel CLI disconnected');
        this.connections.delete(ws);
      });

      ws.on('error', (err) => {
        logger.warn({ err }, 'claude-code-channel WS error');
        this.connections.delete(ws);
      });
    });

    logger.info({ path: this.path }, 'claude-code WS handler attached');
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

  async chat(req: BackendRequest): Promise<string> {
    const { message } = req;
    const sessionId = message.sessionId;

    if (!this.wss) {
      throw new Error(
        'claude-code-channel: WS server not attached — call attach() before sending messages',
      );
    }

    let targetWs: WebSocket | null = null;
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        targetWs = ws;
        break;
      }
    }

    if (!targetWs) {
      throw new Error('claude-code-channel: no connected claude-code-channel CLI — is it running?');
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

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        reject(new Error(`claude-code-channel: reply timeout for session ${sessionId}`));
      }, this.timeoutMs);

      this.pending.set(sessionId, { resolve, reject, timer });

      (targetWs as WebSocket).send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(sessionId);
          reject(new Error(`claude-code-channel: failed to send message: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    this.wss?.close();
  }
}
