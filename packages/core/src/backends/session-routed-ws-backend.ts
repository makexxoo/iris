import { BackendAdapter } from './types.js';
import { BackendRequest, IrisMessage } from '../message.js';
import { ChannelAdapter } from '../channels/types.js';
import { channelAdapterRegistry } from '../channels/registry.js';
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
  channelType: string;
  channelName: string;
  channelUserId: string;
}

export abstract class SessionRoutedWsBackend<TConnection> implements BackendAdapter {
  private readonly connections = new Set<TConnection>();
  private readonly sessionToConnection = new Map<string, TConnection>();
  private readonly pendingByRequestId = new Map<
    string,
    {
      sessionId: string;
      message: BackendRequest['message'];
      channelAdapter: ChannelAdapter;
      timeout: ReturnType<typeof setTimeout>;
      requestId: string;
    }
  >();
  private readonly pendingByRoute = new Map<
    string,
    {
      sessionId: string;
      message: BackendRequest['message'];
      channelAdapter: ChannelAdapter;
      timeout: ReturnType<typeof setTimeout>;
      requestId: string;
    }
  >();
  private readonly unknownWarnAt = new Map<string, number>();

  abstract name: string;

  protected constructor(private readonly timeoutMs: number) {}

  abstract attach(httpServer: Server<typeof IncomingMessage>): void;

  async chat(req: BackendRequest): Promise<void> {
    const { message, channelAdapter } = req;
    const requestId = message.id;
    const sessionId = message.sessionId;

    const connection = this.resolveConnection(sessionId);
    if (!connection) throw new Error(this.noConnectionErrorMessage());

    const payload = JSON.stringify({ ...req.message, sessionId });
    const timeout = setTimeout(() => {
      void this.onReplyTimeout({
        sessionId,
        requestId,
        message: { ...message, sessionId },
        channelAdapter,
      });
      this.pendingByRequestId.delete(requestId);
      this.pendingByRoute.delete(
        this.routeKey(message.channelType, message.channelName, message.channelUserId),
      );
    }, this.timeoutMs);
    const pending = {
      sessionId,
      message: { ...message, sessionId },
      channelAdapter,
      timeout,
      requestId,
    };
    this.pendingByRequestId.set(requestId, pending);
    this.pendingByRoute.set(
      this.routeKey(message.channelType, message.channelName, message.channelUserId),
      pending,
    );

    try {
      await this.sendPayload(connection, payload);
    } catch (err) {
      const pending = this.pendingByRequestId.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingByRequestId.delete(requestId);
      }
      throw err;
    }
  }

  protected async handleInboundRaw(raw: string, connection: TConnection): Promise<void> {
    const inbound = this.parseInboundMessage(raw);
    if (!inbound) return;

    const sessionId = inbound.sessionId;
    const requestId = inbound.id;
    const pending =
      (requestId ? this.pendingByRequestId.get(requestId) : undefined) ??
      this.pendingByRoute.get(
        this.routeKey(inbound.channelType, inbound.channelName, inbound.channelUserId),
      );
    if (!pending) {
      const proactiveAdapter = channelAdapterRegistry.resolveByMessage(inbound);
      if (proactiveAdapter) {
        await proactiveAdapter.reply({
          ...inbound,
          raw: inbound.raw ?? { source: `${this.name}-proactive` },
          timestamp: inbound.timestamp || Date.now(),
        });
        return;
      }
      const unknownKey = `${this.name}::${requestId ?? ''}::${sessionId}::${inbound.channelType}::${inbound.channelName}::${inbound.channelUserId}`;
      const now = Date.now();
      const lastWarnAt = this.unknownWarnAt.get(unknownKey) ?? 0;
      if (now - lastWarnAt > 60_000) {
        this.unknownWarnAt.set(unknownKey, now);
        this.onUnknownReply({
          sessionId,
          requestId,
          channelType: inbound.channelType,
          channelName: inbound.channelName,
          channelUserId: inbound.channelUserId,
        });
      }
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingByRequestId.delete(pending.requestId);
    this.pendingByRoute.delete(
      this.routeKey(inbound.channelType, inbound.channelName, inbound.channelUserId),
    );

    if (this.isConnectionOpen(connection)) {
      this.sessionToConnection.set(pending.sessionId, connection);
    }

    await pending.channelAdapter.reply({
      ...inbound,
      sessionId: inbound.sessionId || pending.sessionId,
      raw: inbound.raw ?? pending.message.raw,
      timestamp: inbound.timestamp || Date.now(),
    });
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
    for (const pending of this.pendingByRequestId.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingByRequestId.clear();
    this.pendingByRoute.clear();
    this.sessionToConnection.clear();
    this.connections.clear();
    this.unknownWarnAt.clear();
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
        channelType: ctx.channelType,
        channelName: ctx.channelName,
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

  private routeKey(channelType: string, channelName: string, channelUserId: string): string {
    return `${channelType}::${channelName}::${channelUserId}`;
  }

  private parseInboundMessage(raw: string): IrisMessage | undefined {
    try {
      return JSON.parse(raw) as IrisMessage;
    } catch (err) {
      logger.warn({ error: err, backed: this.name }, 'invalid backend inbound envelope');
    }
  }
}
