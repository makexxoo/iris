import { ChannelAdapter } from '../channels/types';
import { IrisMessage } from '../message';

export interface ManagedSessionState {
  backendName: string;
  sessionId: string;
  routeChannel: string;
  routeChannelUserId: string;
  requestId?: string;
  message: IrisMessage;
  channelAdapter: ChannelAdapter;
  responseTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface UpsertSessionParams {
  backendName: string;
  sessionId: string;
  requestId?: string;
  message: IrisMessage;
  channelAdapter: ChannelAdapter;
  responseTimeoutMs: number;
  onResponseTimeout: (state: ManagedSessionState) => Promise<void> | void;
}

interface SharedSessionStore {
  sessionStates: Map<string, ManagedSessionState>; // key: backendName::sessionId
  routeToSession: Map<string, string>; // key: backendName::channel::channelUserId -> sessionStoreKey
  requestToSession: Map<string, string>; // key: backendName::requestId -> sessionStoreKey
  recentlyCompleted: Map<string, number>;
}

const sharedStore: SharedSessionStore = {
  sessionStates: new Map<string, ManagedSessionState>(),
  routeToSession: new Map<string, string>(),
  requestToSession: new Map<string, string>(),
  recentlyCompleted: new Map<string, number>(),
};

export class SessionStateManager {
  constructor(
    private readonly idleTtlMs: number,
    private readonly unknownSuppressMs: number = 60_000,
  ) {}

  getBySession(backendName: string, sessionId: string): ManagedSessionState | undefined {
    return sharedStore.sessionStates.get(this.sessionKey(backendName, sessionId));
  }

  getByRoute(
    backendName: string,
    channel: string,
    channelUserId: string,
  ): ManagedSessionState | undefined {
    const routeKey = this.routeKey(backendName, channel, channelUserId);
    const sessionKey = sharedStore.routeToSession.get(routeKey);
    if (!sessionKey) return undefined;
    return sharedStore.sessionStates.get(sessionKey);
  }

  resolveReusableSessionId(params: {
    backendName: string;
    channel: string;
    channelUserId: string;
    fallbackSessionId: string;
  }): string {
    const { backendName, channel, channelUserId, fallbackSessionId } = params;
    const existed = this.getByRoute(backendName, channel, channelUserId);
    return existed?.sessionId ?? fallbackSessionId;
  }

  resolveInboundState(params: {
    backendName: string;
    sessionId?: string;
    requestId?: string;
    channel: string;
    channelUserId: string;
  }): ManagedSessionState | undefined {
    const { backendName, sessionId, requestId, channel, channelUserId } = params;
    if (sessionId) {
      const bySession = this.getBySession(backendName, sessionId);
      if (bySession) return bySession;
    }
    if (requestId) {
      const requestKey = this.requestKey(backendName, requestId);
      const sessionKey = sharedStore.requestToSession.get(requestKey);
      if (sessionKey) {
        const byRequest = sharedStore.sessionStates.get(sessionKey);
        if (byRequest) return byRequest;
      }
    }
    return this.getByRoute(backendName, channel, channelUserId);
  }

  upsert(params: UpsertSessionParams): ManagedSessionState {
    const {
      backendName,
      sessionId,
      requestId,
      message,
      channelAdapter,
      responseTimeoutMs,
      onResponseTimeout,
    } = params;
    const sessionStoreKey = this.sessionKey(backendName, sessionId);
    const previous = sharedStore.sessionStates.get(sessionStoreKey);
    if (previous?.responseTimer) clearTimeout(previous.responseTimer);
    if (previous?.idleTimer) clearTimeout(previous.idleTimer);

    const state: ManagedSessionState =
      previous ??
      ({
        backendName,
        sessionId,
        routeChannel: message.channel,
        routeChannelUserId: message.channelUserId,
        requestId,
        message,
        channelAdapter,
      } satisfies ManagedSessionState);
    state.backendName = backendName;
    state.message = message;
    state.channelAdapter = channelAdapter;
    state.routeChannel = message.channel;
    state.routeChannelUserId = message.channelUserId;
    state.requestId = requestId;
    state.idleTimer = undefined;
    state.responseTimer = setTimeout(async () => {
      try {
        await onResponseTimeout(state);
      } finally {
        const current = sharedStore.sessionStates.get(sessionStoreKey);
        if (current) {
          current.responseTimer = undefined;
          this.scheduleIdleCleanup(current);
        }
      }
    }, responseTimeoutMs);

    sharedStore.sessionStates.set(sessionStoreKey, state);
    sharedStore.routeToSession.set(
      this.routeKey(backendName, message.channel, message.channelUserId),
      sessionStoreKey,
    );
    if (requestId) {
      sharedStore.requestToSession.set(this.requestKey(backendName, requestId), sessionStoreKey);
    }
    return state;
  }

  markResponseEnded(backendName: string, sessionId: string): void {
    const state = this.getBySession(backendName, sessionId);
    if (!state) return;
    if (state.responseTimer) {
      clearTimeout(state.responseTimer);
      state.responseTimer = undefined;
    }
    this.scheduleIdleCleanup(state);
  }

  markFinal(backendName: string, sessionId: string, requestId?: string): void {
    this.markResponseEnded(backendName, sessionId);
    const now = Date.now();
    sharedStore.recentlyCompleted.set(this.sessionKey(backendName, sessionId), now);
    if (requestId) sharedStore.recentlyCompleted.set(this.requestKey(backendName, requestId), now);
    const state = this.getBySession(backendName, sessionId);
    if (state) {
      sharedStore.recentlyCompleted.set(
        this.routeKey(backendName, state.routeChannel, state.routeChannelUserId),
        now,
      );
    }
  }

  shouldWarnUnknown(params: {
    backendName: string;
    sessionId?: string;
    requestId?: string;
    channel?: string;
    channelUserId?: string;
  }): boolean {
    const { backendName, sessionId, requestId, channel, channelUserId } = params;
    const now = Date.now();
    const completedCandidates = [
      requestId ? sharedStore.recentlyCompleted.get(this.requestKey(backendName, requestId)) : 0,
      sessionId ? sharedStore.recentlyCompleted.get(this.sessionKey(backendName, sessionId)) : 0,
      channel && channelUserId
        ? sharedStore.recentlyCompleted.get(this.routeKey(backendName, channel, channelUserId))
        : 0,
    ].filter(Boolean) as number[];
    const completedAt = completedCandidates.length > 0 ? Math.max(...completedCandidates) : 0;
    return !completedAt || now - completedAt > this.unknownSuppressMs;
  }

  clear(): void {
    for (const state of sharedStore.sessionStates.values()) {
      if (state.responseTimer) clearTimeout(state.responseTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    sharedStore.sessionStates.clear();
    sharedStore.routeToSession.clear();
    sharedStore.requestToSession.clear();
    sharedStore.recentlyCompleted.clear();
  }

  private scheduleIdleCleanup(state: ManagedSessionState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    const sessionStoreKey = this.sessionKey(state.backendName, state.sessionId);
    const routeKey = this.routeKey(state.backendName, state.routeChannel, state.routeChannelUserId);
    const requestKey = state.requestId ? this.requestKey(state.backendName, state.requestId) : null;
    state.idleTimer = setTimeout(() => {
      sharedStore.sessionStates.delete(sessionStoreKey);
      if (sharedStore.routeToSession.get(routeKey) === sessionStoreKey) {
        sharedStore.routeToSession.delete(routeKey);
      }
      if (requestKey && sharedStore.requestToSession.get(requestKey) === sessionStoreKey) {
        sharedStore.requestToSession.delete(requestKey);
      }
      sharedStore.recentlyCompleted.set(routeKey, Date.now());
    }, this.idleTtlMs);
  }

  private sessionKey(backendName: string, sessionId: string): string {
    return `${backendName}::${sessionId}`;
  }

  private routeKey(backendName: string, channel: string, channelUserId: string): string {
    return `${backendName}::${channel}::${channelUserId}`;
  }

  private requestKey(backendName: string, requestId: string): string {
    return `${backendName}::${requestId}`;
  }
}
