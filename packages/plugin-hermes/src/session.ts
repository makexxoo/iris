/**
 * Tracks per-session state for hermes-agent conversations.
 * Ensures messages for the same sessionId are processed serially.
 */

export interface SessionState {
  queue: Array<() => Promise<void>>;
  processing: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  getOrCreate(sessionId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { queue: [], processing: false });
    }
    return this.sessions.get(sessionId)!;
  }

  enqueue(sessionId: string, task: () => Promise<void>): void {
    const state = this.getOrCreate(sessionId);
    state.queue.push(task);
    if (!state.processing) {
      this.drain(sessionId).catch(() => {});
    }
  }

  private async drain(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.processing = true;
    while (state.queue.length > 0) {
      const task = state.queue.shift()!;
      try {
        await task();
      } catch {
        // individual task errors are handled inside the task
      }
    }
    state.processing = false;
  }
}
