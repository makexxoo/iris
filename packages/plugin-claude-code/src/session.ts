export interface SessionState {
  /** Claude Code SDK session ID for resuming conversations. Set after first exchange. */
  sdkSessionId: string | undefined;
  /** Pending tasks queued for this session (processed serially). */
  queue: Array<() => Promise<void>>;
  processing: boolean;
}

/**
 * Tracks one Claude Code session per iris sessionId.
 * Enqueued tasks run serially per session to avoid concurrent SDK calls on the same session.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();

  getOrCreate(sessionId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { sdkSessionId: undefined, queue: [], processing: false });
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
