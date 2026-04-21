import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type {
  BackendRequest,
  InboundReplyMessage,
  MessageAttachment,
  MessageContent,
  ReplyTimeoutContext,
  UnknownReplyContext,
} from '@agent-iris/core';
import { SessionStateManager, WebSocketSessionBackend } from '@agent-iris/core';

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
    const type = text ? 'text' : attachments.length > 0 ? attachments[0].type : 'text';
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
  wsPath?: string;
}

/**
 * Backend adapter that connects to the hermes-agent plugin (plugin-hermes) via WebSocket.
 *
 * iris runs the WS **server**; plugin-hermes is the WS **client**.
 * This mirrors the openclaw-channel and claude-code-channel pattern exactly.
 *
 * Protocol:
 *   iris → plugin (WS): { type: 'message', id, channel, channelUserId, sessionId, content, timestamp, context }
 *   plugin → iris (WS): { type: 'reply', sessionId, content: ContentPart[] }
 *                    or (legacy): { type: 'reply', sessionId, text: string }
 */
export class HermesBackend extends WebSocketSessionBackend {
  name = 'hermes';

  constructor(config: HermesBackendConfig, sessionStates: SessionStateManager) {
    const timeoutMs = config.timeoutMs ?? 300_000;
    super(timeoutMs, sessionStates, config.wsPath ?? '/ws/hermes');
    this.name = config.name ?? 'hermes';
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
    const m = msg as Record<string, unknown>;
    const type = m['type'];
    if (type !== 'reply' && type !== 'reply_update') return null;
    const sessionId = typeof m['sessionId'] === 'string' ? (m['sessionId'] as string) : '';
    if (!sessionId) return null;
    const requestId = String(m['requestId'] ?? m['replyTo'] ?? m['messageId'] ?? '').trim();
    return {
      type,
      sessionId,
      requestId: requestId || undefined,
      content: parseReplyContent(m),
    };
  }

  protected noConnectionErrorMessage(): string {
    if (!this.isWsAttached()) {
      return 'hermes: WS server not attached — call attach() before sending messages';
    }
    return 'hermes: no connected plugin-hermes instance — is it running?';
  }

  protected async onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void> {
    const { sessionId, requestId, message, channelAdapter } = ctx;
    logger.warn({ sessionId, requestId }, 'hermes: reply timeout');
    try {
      await channelAdapter.reply({
        ...message,
        timestamp: Date.now(),
        content: {
          type: 'text',
          text: `hermes: reply timeout for session ${sessionId}`,
        },
      });
    } catch (err) {
      logger.warn({ err, sessionId, requestId }, 'failed to send timeout reply');
    }
  }

  protected onUnknownReply(ctx: UnknownReplyContext): void {
    logger.warn(
      { sessionId: ctx.sessionId, requestId: ctx.requestId },
      'received reply for unknown request',
    );
  }

  close(): void {
    this.closeWs();
  }
}
