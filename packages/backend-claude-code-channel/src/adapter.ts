import type { IncomingMessage, Server } from 'http';
import pino from 'pino';
import type {
  BackendOutboundEnvelope,
  BackendRequest,
  InboundReplyMessage,
  ReplyTimeoutContext,
  UnknownReplyContext,
} from '@agent-iris/core';
import {
  SessionStateManager,
  WebSocketSessionBackend,
  parseBackendInboundEnvelope as parseInboundEnvelope,
  BACKEND_PROTOCOL_VERSION as protocolVersion,
} from '@agent-iris/core';

const logger = pino({ name: 'backend-claude-code' });

export interface ClaudeCodeChannelConfig {
  /** Name used for routing in MessageEngine (default: 'claude-code') */
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/claude-code) */
  wsPath?: string;
}

/**
 * Backend adapter that connects to a claude-code-channel CLI via WebSocket.
 *
 * iris runs the WS server; the claude-code-channel CLI is the WS client.
 *
 * Protocol (identical to openclaw-channel):
 *   iris → CLI: { version: 2, type: 'message', payload: { messageId, sessionId, channel, channelUserId, content, context } }
 *   CLI → iris: { version: 2, type: 'message|message_update', payload: { sessionId?, channel, channelUserId, content } }
 */
export class ClaudeCodeChannelBackend extends WebSocketSessionBackend {
  name = 'claude-code';

  constructor(
    private config: ClaudeCodeChannelConfig,
    sessionStates: SessionStateManager,
  ) {
    const timeoutMs = config.timeoutMs ?? 900_000;
    super(timeoutMs, sessionStates, config.wsPath ?? '/ws/claude-code');
    this.name = config.name ?? 'claude-code';
  }

  protected buildOutboundPayload(req: BackendRequest): string {
    const { message } = req;
    const envelope: BackendOutboundEnvelope = {
      version: protocolVersion,
      type: 'message',
      timestamp: message.timestamp,
      traceId: message.id,
      payload: {
        messageId: message.id,
        sessionId: message.sessionId,
        channel: message.channel,
        channelUserId: message.channelUserId,
        content: message.content,
        context: req.context,
      },
    };
    return JSON.stringify(envelope);
  }

  protected parseInboundMessage(raw: string): InboundReplyMessage | null {
    const parsed = parseInboundEnvelope(raw);
    if (!parsed.envelope) {
      if (parsed.error) logger.warn({ error: parsed.error }, 'invalid backend inbound envelope');
      return null;
    }
    const { type, payload } = parsed.envelope;
    return {
      type,
      channel: payload.channel,
      channelUserId: payload.channelUserId,
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      conversationId: payload.conversationId,
      content: payload.content,
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
        content: {
          type: 'text',
          text: `claude-code-channel: reply timeout for session ${sessionId}`,
        },
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'failed to send timeout reply');
    }
  }

  protected onUnknownReply(ctx: UnknownReplyContext): void {
    logger.warn(
      {
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        channel: ctx.channel,
        channelUserId: ctx.channelUserId,
      },
      'received reply for unknown route',
    );
  }

  close(): void {
    this.closeWs();
  }
}
