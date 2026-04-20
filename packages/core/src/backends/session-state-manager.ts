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

export class SessionStateManager {
  private readonly sessionStates = new Map<string, ManagedSessionState>();
  private readonly recentlyCompleted = new Map<string, number>();

  constructor(
    private readonly idleTtlMs: number,
    private readonly unknownSuppressMs: number = 60_000,
  ) {}

  get(sessionId: string): ManagedSessionState | undefined {
    return this.sessionStates.get(sessionId);
  }

  upsert(params: UpsertSessionParams): ManagedSessionState {
    const { sessionId, message, channelAdapter, responseTimeoutMs, onResponseTimeout } = params;
    const previous = this.sessionStates.get(sessionId);
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
        const current = this.sessionStates.get(sessionId);
        if (current) {
          current.responseTimer = undefined;
          this.scheduleIdleCleanup(sessionId);
        }
      }
    }, responseTimeoutMs);

    this.sessionStates.set(sessionId, state);
    return state;
  }

  markResponseEnded(sessionId: string): void {
    const state = this.sessionStates.get(sessionId);
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
    this.recentlyCompleted.set(sessionId, now);
    if (requestId) this.recentlyCompleted.set(requestId, now);
  }

  shouldWarnUnknown(sessionId: string, requestId?: string): boolean {
    const now = Date.now();
    const completedAt =
      (requestId ? this.recentlyCompleted.get(requestId) : undefined) ??
      this.recentlyCompleted.get(sessionId) ??
      0;
    return !completedAt || now - completedAt > this.unknownSuppressMs;
  }

  clear(): void {
    for (const state of this.sessionStates.values()) {
      if (state.responseTimer) clearTimeout(state.responseTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    this.sessionStates.clear();
    this.recentlyCompleted.clear();
  }

  private scheduleIdleCleanup(sessionId: string): void {
    const state = this.sessionStates.get(sessionId);
    if (!state) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      this.sessionStates.delete(sessionId);
    }, this.idleTtlMs);
  }
}
