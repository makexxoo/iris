import { describe, it, expect } from 'bun:test';
import { SessionManager } from './session';

describe('SessionManager', () => {
  it('creates a new session on first access', () => {
    const mgr = new SessionManager();
    const state = mgr.getOrCreate('session-1');
    expect(state.sdkSessionId).toBeUndefined();
    expect(state.processing).toBe(false);
  });

  it('returns the same state object on subsequent calls', () => {
    const mgr = new SessionManager();
    const a = mgr.getOrCreate('session-1');
    const b = mgr.getOrCreate('session-1');
    expect(a).toBe(b);
  });

  it('serialises tasks for the same sessionId', async () => {
    const mgr = new SessionManager();
    const order: number[] = [];

    const p1 = new Promise<void>((resolve) => {
      mgr.enqueue('session-1', async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
        resolve();
      });
    });

    const p2 = new Promise<void>((resolve) => {
      mgr.enqueue('session-1', async () => {
        order.push(2);
        resolve();
      });
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('runs tasks for different sessions concurrently', async () => {
    const mgr = new SessionManager();
    const started: string[] = [];

    const p1 = new Promise<void>((resolve) => {
      mgr.enqueue('session-A', async () => {
        started.push('A');
        await new Promise((r) => setTimeout(r, 30));
        resolve();
      });
    });

    const p2 = new Promise<void>((resolve) => {
      mgr.enqueue('session-B', async () => {
        started.push('B');
        resolve();
      });
    });

    // Give both a tick to start
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toContain('A');
    expect(started).toContain('B');
    await Promise.all([p1, p2]);
  });
});
