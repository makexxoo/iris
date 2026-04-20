import { BackendAdapter } from './types';
import { SessionStateManager } from './session-state-manager';
import { BackendRequest, MessageContent } from '../message';
import { ChannelAdapter } from '../channels/types';

export interface BackendChatRequest extends BackendRequest {
  channelAdapter: ChannelAdapter;
}

export interface InboundReplyMessage {
  type: 'reply' | 'reply_update';
  sessionId: string;
  requestId?: string;
  content: MessageContent;
}

export interface ReplyTimeoutContext {
  sessionId: string;
  requestId: string;
  message: BackendRequest['message'];
  channelAdapter: ChannelAdapter;
}

export interface UnknownReplyContext {
  sessionId: string;
  requestId?: string;
}

export abstract class SessionRoutedWsBackend<TConnection> implements BackendAdapter {
  private readonly connections = new Set<TConnection>();
  private readonly sessionToConnection = new Map<string, TConnection>();
  private readonly sessionStates: SessionStateManager;

  abstract name: string;

  protected constructor(
    private readonly timeoutMs: number,
    idleTtlMs: number = 10 * 60 * 1000,
  ) {
    this.sessionStates = new SessionStateManager(idleTtlMs);
  }

  async chat(req: BackendChatRequest): Promise<void> {
    const { message, channelAdapter } = req;
    const sessionId = message.sessionId;
    const requestId = message.id;

    const connection = this.resolveConnection(sessionId);
    if (!connection) throw new Error(this.noConnectionErrorMessage());

    const payload = this.buildOutboundPayload(req);
    this.sessionStates.upsert({
      sessionId,
      message: { ...message },
      channelAdapter,
      responseTimeoutMs: this.timeoutMs,
      onResponseTimeout: async () => {
        await this.onReplyTimeout({ sessionId, requestId, message, channelAdapter });
      },
    });

    try {
      await this.sendPayload(connection, payload);
    } catch (err) {
      this.sessionStates.markResponseEnded(sessionId);
      throw err;
    }
  }

  protected async handleInboundRaw(raw: string, connection: TConnection): Promise<void> {
    const inbound = this.parseInboundMessage(raw);
    if (!inbound) return;

    const { sessionId, requestId } = inbound;
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      if (this.sessionStates.shouldWarnUnknown(sessionId, requestId)) {
        this.onUnknownReply({ sessionId, requestId });
      }
      return;
    }

    if (this.isConnectionOpen(connection)) {
      this.sessionToConnection.set(sessionId, connection);
    }

    await state.channelAdapter.reply({
      ...state.message,
      content: inbound.content,
      timestamp: Date.now(),
    });

    if (inbound.type === 'reply') {
      this.sessionStates.markFinal(sessionId, requestId);
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

  protected abstract isConnectionOpen(connection: TConnection): boolean;
  protected abstract sendPayload(connection: TConnection, payload: string): Promise<void>;
  protected abstract buildOutboundPayload(req: BackendRequest): string;
  protected abstract parseInboundMessage(raw: string): InboundReplyMessage | null;
  protected abstract noConnectionErrorMessage(): string;
  protected abstract onReplyTimeout(ctx: ReplyTimeoutContext): Promise<void>;
  protected abstract onUnknownReply(ctx: UnknownReplyContext): void;
}
