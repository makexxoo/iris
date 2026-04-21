import { ChannelAdapter } from '../channels/types';
import { IrisMessage } from '../message';

export interface ManagedSessionState {
  sessionId: string;
  message: IrisMessage;
  channelAdapter: ChannelAdapter;
  responseTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface UpsertSessionParams {
  sessionId: string;
  message: IrisMessage;
  channelAdapter: ChannelAdapter;
  responseTimeoutMs: number;
  onResponseTimeout: (state: ManagedSessionState) => Promise<void> | void;
}

interface SharedSessionStore {
  sessionStates: Map<string, ManagedSessionState>;
  recentlyCompleted: Map<string, number>;
}

const sharedStore: SharedSessionStore = {
  sessionStates: new Map<string, ManagedSessionState>(),
  recentlyCompleted: new Map<string, number>(),
};

export class SessionStateManager {
  constructor(
    private readonly idleTtlMs: number,
    private readonly unknownSuppressMs: number = 60_000,
  ) {}

  get(sessionId: string): ManagedSessionState | undefined {
    return sharedStore.sessionStates.get(sessionId);
  }

  upsert(params: UpsertSessionParams): ManagedSessionState {
    const { sessionId, message, channelAdapter, responseTimeoutMs, onResponseTimeout } = params;
    const previous = sharedStore.sessionStates.get(sessionId);
    if (previous?.responseTimer) clearTimeout(previous.responseTimer);
    if (previous?.idleTimer) clearTimeout(previous.idleTimer);

    const state: ManagedSessionState = previous ?? { sessionId, message, channelAdapter };
    state.message = message;
    state.channelAdapter = channelAdapter;
    state.idleTimer = undefined;
    state.responseTimer = setTimeout(async () => {
      try {
        await onResponseTimeout(state);
      } finally {
        const current = sharedStore.sessionStates.get(sessionId);
        if (current) {
          current.responseTimer = undefined;
          this.scheduleIdleCleanup(sessionId);
        }
      }
    }, responseTimeoutMs);

    sharedStore.sessionStates.set(sessionId, state);
    return state;
  }

  markResponseEnded(sessionId: string): void {
    const state = sharedStore.sessionStates.get(sessionId);
    if (!state) return;
    if (state.responseTimer) {
      clearTimeout(state.responseTimer);
      state.responseTimer = undefined;
    }
    this.scheduleIdleCleanup(sessionId);
  }

  markFinal(sessionId: string, requestId?: string): void {
    this.markResponseEnded(sessionId);
    const now = Date.now();
    sharedStore.recentlyCompleted.set(sessionId, now);
    if (requestId) sharedStore.recentlyCompleted.set(requestId, now);
  }

  shouldWarnUnknown(sessionId: string, requestId?: string): boolean {
    const now = Date.now();
    const completedAt =
      (requestId ? sharedStore.recentlyCompleted.get(requestId) : undefined) ??
      sharedStore.recentlyCompleted.get(sessionId) ??
      0;
    return !completedAt || now - completedAt > this.unknownSuppressMs;
  }

  clear(): void {
    for (const state of sharedStore.sessionStates.values()) {
      if (state.responseTimer) clearTimeout(state.responseTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    sharedStore.sessionStates.clear();
    sharedStore.recentlyCompleted.clear();
  }

  private scheduleIdleCleanup(sessionId: string): void {
    const state = sharedStore.sessionStates.get(sessionId);
    if (!state) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      sharedStore.sessionStates.delete(sessionId);
    }, this.idleTtlMs);
  }
}
