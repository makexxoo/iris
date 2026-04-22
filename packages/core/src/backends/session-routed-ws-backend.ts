import { BackendAdapter } from './types.js';
import { SessionStateManager } from './session-state-manager.js';
import { BackendRequest, IrisMessage } from '../message.js';
import { ChannelAdapter } from '../channels/types.js';
import type { IncomingMessage, Server } from 'http';
import pino from 'pino';

const logger = pino({ name: 'session-backend-ws' });

export interface ReplyTimeoutContext {
  sessionId: string;
  requestId: string;
  message: BackendRequest['message'];
  channelAdapter: ChannelAdapter;
}

export interface UnknownReplyContext {
  sessionId?: string;
  requestId?: string;
  channel: string;
  channelUserId: string;
}

export abstract class SessionRoutedWsBackend<TConnection> implements BackendAdapter {
  private readonly connections = new Set<TConnection>();
  private readonly sessionToConnection = new Map<string, TConnection>();

  abstract name: string;

  protected constructor(
    private readonly timeoutMs: number,
    private readonly sessionStates: SessionStateManager,
  ) {}

  abstract attach(httpServer: Server<typeof IncomingMessage>): void;

  async chat(req: BackendRequest): Promise<void> {
    const { message, channelAdapter } = req;
    const requestId = message.id;
    const sessionId = this.sessionStates.resolveReusableSessionId({
      backendName: this.name,
      channel: message.channel,
      channelUserId: message.channelUserId,
      fallbackSessionId: message.sessionId,
    });
    const resolvedMessage = { ...message, sessionId };

    const connection = this.resolveConnection(sessionId);
    if (!connection) throw new Error(this.noConnectionErrorMessage());

    const payload = JSON.stringify(req.message);
    this.sessionStates.upsert({
      backendName: this.name,
      sessionId,
      requestId,
      message: resolvedMessage,
      channelAdapter,
      responseTimeoutMs: this.timeoutMs,
      onResponseTimeout: async () => {
        await this.onReplyTimeout({
          sessionId,
          requestId,
          message: resolvedMessage,
          channelAdapter,
        });
      },
    });

    try {
      await this.sendPayload(connection, payload);
    } catch (err) {
      this.sessionStates.markResponseEnded(this.name, sessionId);
      throw err;
    }
  }

  protected async handleInboundRaw(raw: string, connection: TConnection): Promise<void> {
    const inbound = this.parseInboundMessage(raw);
    if (!inbound) return;

    const sessionId = inbound.sessionId;
    const requestId = inbound.id;
    const state = this.sessionStates.resolveInboundState({
      backendName: this.name,
      sessionId,
      requestId,
      channel: inbound.channel,
      channelUserId: inbound.channelUserId,
    });
    if (!state) {
      if (
        this.sessionStates.shouldWarnUnknown({
          backendName: this.name,
          sessionId,
          requestId,
          channel: inbound.channel,
          channelUserId: inbound.channelUserId,
        })
      ) {
        this.onUnknownReply({
          sessionId,
          requestId,
          channel: inbound.channel,
          channelUserId: inbound.channelUserId,
        });
      }
      return;
    }

    if (this.isConnectionOpen(connection)) {
      this.sessionToConnection.set(state.sessionId, connection);
    }

    await state.channelAdapter.reply({
      ...inbound,
      sessionId: inbound.sessionId || state.sessionId,
      raw: inbound.raw ?? state.message.raw,
      timestamp: inbound.timestamp || Date.now(),
    });

    if (state.sessionId) {
      this.sessionStates.markFinal(this.name, state.sessionId, requestId);
    }
  }

  protected forgetConnection(connection: TConnection): void {
    for (const [sid, mapped] of this.sessionToConnection.entries()) {
      if (mapped === connection) this.sessionToConnection.delete(sid);
    }
  }

  protected registerConnection(connection: TConnection): void {
    this.connections.add(connection);
  }

  protected unregisterConnection(connection: TConnection): void {
    this.connections.delete(connection);
    this.forgetConnection(connection);
  }

  protected clearState(): void {
    this.sessionStates.clear();
    this.sessionToConnection.clear();
    this.connections.clear();
  }

  protected abstract isConnectionOpen(connection: TConnection): boolean;
  protected abstract sendPayload(connection: TConnection, payload: string): Promise<void>;
  protected abstract noConnectionErrorMessage(): string;
  protected async onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void> {
    const { sessionId, requestId, message, channelAdapter } = ctx;
    logger.warn({ sessionId, requestId, backend: this.name }, `reply timeout`);
    try {
      await channelAdapter.reply({
        ...message,
        timestamp: Date.now(),
        content: [{ type: 'text', text: `${this.name}: reply timeout for session ${sessionId}` }],
      });
    } catch (err) {
      logger.warn(
        { err, sessionId, requestId, backend: this.name },
        'failed to send timeout reply',
      );
    }
  }
  protected onUnknownReply(ctx: UnknownReplyContext): void {
    logger.warn(
      {
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        channel: ctx.channel,
        channelUserId: ctx.channelUserId,
        backend: this.name,
      },
      'received reply for unknown request',
    );
  }

  private resolveConnection(sessionId: string): TConnection | null {
    const mapped = this.sessionToConnection.get(sessionId);
    if (mapped && this.isConnectionOpen(mapped)) return mapped;

    for (const conn of this.connections.values()) {
      if (!this.isConnectionOpen(conn)) continue;
      this.sessionToConnection.set(sessionId, conn);
      return conn;
    }
    return null;
  }

  private parseInboundMessage(raw: string): IrisMessage | undefined {
    try {
      return JSON.parse(raw) as IrisMessage;
    } catch (err) {
      logger.warn({ error: err, backed: this.name }, 'invalid backend inbound envelope');
    }
  }
}
