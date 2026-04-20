import { WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type {
  BackendRequest,
  InboundReplyMessage,
  ReplyTimeoutContext,
  UnknownReplyContext,
} from '@agent-iris/core';
import { WebSocketSessionBackend } from '@agent-iris/core';

const logger = pino({ name: 'backend-claude-code' });

export interface ClaudeCodeChannelConfig {
  /** Name used for routing in MessageEngine (default: 'claude-code') */
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/claude-code) */
  path?: string;
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
export class ClaudeCodeChannelBackend extends WebSocketSessionBackend {
  private static readonly SESSION_IDLE_TTL_MS = 10 * 60 * 1000;

  private readonly path: string;

  name = 'claude-code';

  constructor(private config: ClaudeCodeChannelConfig) {
    const timeoutMs = config.timeoutMs ?? 900_000;
    super(timeoutMs, ClaudeCodeChannelBackend.SESSION_IDLE_TTL_MS);
    this.name = config.name ?? 'claude-code';
    this.path = config.path ?? '/ws/claude-code';
  }

  /** Attach the WS handler to an existing HTTP server. Call before listen(). */
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
      return 'claude-code-channel: WS server not attached — call attach() before sending messages';
    }
    return 'claude-code-channel: no connected claude-code-channel CLI — is it running?';
  }

  protected async onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void> {
    const { sessionId, message, channelAdapter } = ctx;
    logger.warn({ sessionId }, 'claude-code-channel: reply timeout');
    try {
      await channelAdapter.reply({
        ...message,
        timestamp: Date.now(),
        content: { type: 'text', text: `claude-code-channel: reply timeout for session ${sessionId}` },
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'failed to send timeout reply');
    }
  }

  protected onUnknownReply(ctx: UnknownReplyContext): void {
    logger.warn({ sessionId: ctx.sessionId }, 'received reply for unknown session');
  }

  protected onWsAttached(path: string): void {
    logger.info({ path }, 'claude-code WS handler attached');
  }

  protected onWsConnected(_connection: WebSocket): void {
    logger.info('claude-code-channel CLI connected');
  }

  protected onWsDisconnected(_connection: WebSocket): void {
    logger.info('claude-code-channel CLI disconnected');
  }

  protected onWsError(_connection: WebSocket, err: unknown): void {
    logger.warn({ err }, 'claude-code-channel WS error');
  }

  protected formatSendError(errorMessage: string): string {
    return `claude-code-channel: failed to send message: ${errorMessage}`;
  }

  close(): void {
    this.closeWs();
  }
}
