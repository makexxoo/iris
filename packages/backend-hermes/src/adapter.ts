import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type { BackendAdapter, BackendRequest, MessageContent, MessageAttachment } from '@agent-iris/core';

const logger = pino({ name: 'backend-hermes' });

function mimeToAttachmentType(mime: string): MessageAttachment['type'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function parseReplyContent(msg: Record<string, unknown>): MessageContent {
  // New format: content array
  if (Array.isArray(msg['content'])) {
    const parts = msg['content'] as Array<Record<string, unknown>>;
    const text = parts
      .filter((p) => p['type'] === 'text')
      .map((p) => String(p['text'] ?? ''))
      .join('');
    const attachments: MessageAttachment[] = parts
      .filter((p) => p['type'] === 'image_url')
      .map((p) => {
        const imageUrl = (p['image_url'] as Record<string, unknown>) ?? {};
        const url = String(imageUrl['url'] ?? '');
        const detail = String(imageUrl['detail'] ?? 'file');
        // url format: data:<mime>;base64,<data>
        const commaIdx = url.indexOf(',');
        const meta = commaIdx >= 0 ? url.slice(0, commaIdx) : '';
        const base64 = commaIdx >= 0 ? url.slice(commaIdx + 1) : '';
        const mimeType = meta.replace('data:', '').replace(';base64', '');
        return {
          type: mimeToAttachmentType(mimeType),
          fileName: detail,
          mimeType,
          base64,
        } satisfies MessageAttachment;
      });
    const type = attachments.length > 0 ? attachments[0].type : 'text';
    return { type, text, attachments: attachments.length > 0 ? attachments : undefined };
  }

  // Old format fallback: text field
  return { type: 'text', text: String(msg['text'] ?? '') };
}

export interface HermesBackendConfig {
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/hermes) */
  path?: string;
}

interface PendingReply {
  resolve: (content: MessageContent) => void;
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

    const m = msg as Record<string, unknown>;
    if (m['type'] !== 'reply' || typeof m['sessionId'] !== 'string') return;

    const sessionId = m['sessionId'] as string;
    const pending = this.pending.get(sessionId);
    if (!pending) {
      logger.warn({ sessionId }, 'received reply for unknown session');
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(sessionId);
    pending.resolve(parseReplyContent(m));
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

    return new Promise<MessageContent>((resolve, reject) => {
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
  }

  close(): void {
    this.wss?.close();
  }
}
