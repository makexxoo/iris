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
 *   iris → openclaw (WS): { version: 2, type: 'message', payload: { messageId, sessionId, channel, channelUserId, content, context } }
 *   openclaw → iris (WS): { version: 2, type: 'message|message_update', payload: { sessionId?, channel, channelUserId, content } }
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
