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
  parseBackendInboundEnvelope,
  BACKEND_PROTOCOL_VERSION,
} from '@agent-iris/core';

const logger = pino({ name: 'backend-iris' });

export interface IrisBackendConfig {
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
 *   iris → plugin (WS): { version: 2, type: 'message', payload: { messageId, sessionId, channel, channelUserId, content, context } }
 *   plugin → iris (WS): { version: 2, type: 'message|message_update', payload: { sessionId?, channel, channelUserId, content } }
 */
export class IrisBackend extends WebSocketSessionBackend {
  name = 'iris';

  constructor(config: IrisBackendConfig, sessionStates: SessionStateManager) {
    const timeoutMs = config.timeoutMs ?? 300_000;
    super(timeoutMs, sessionStates, config.wsPath ?? '/ws/iris');
    this.name = config.name ?? 'iris';
  }

  protected buildOutboundPayload(req: BackendRequest): string {
    const { message } = req;
    const envelope: BackendOutboundEnvelope = {
      version: BACKEND_PROTOCOL_VERSION,
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
    const parsed = parseBackendInboundEnvelope(raw);
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
      return 'iris: WS server not attached — call attach() before sending messages';
    }
    return 'iris: no connected plugin-hermes instance — is it running?';
  }

  protected async onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void> {
    const { sessionId, requestId, message, channelAdapter } = ctx;
    logger.warn({ sessionId, requestId }, 'iris: reply timeout');
    try {
      await channelAdapter.reply({
        ...message,
        timestamp: Date.now(),
        content: {
          type: 'text',
          text: `iris: reply timeout for session ${sessionId}`,
        },
      });
    } catch (err) {
      logger.warn({ err, sessionId, requestId }, 'failed to send timeout reply');
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
      'received reply for unknown request',
    );
  }

  close(): void {
    this.closeWs();
  }
}
