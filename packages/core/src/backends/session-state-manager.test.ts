import { describe, expect, it } from 'bun:test';
import { SessionStateManager } from './session-state-manager';
import type { ChannelAdapter } from '../channels/types';
import type { IrisMessage } from '../message';

function mockChannelAdapter(): ChannelAdapter {
  return {
    name: 'mock',
    support: () => true,
    register: () => undefined,
    reply: async () => undefined,
  };
}

function mockMessage(sessionId: string): IrisMessage {
  return {
    id: `msg-${sessionId}`,
    channel: 'feishu',
    channelUserId: 'user-1',
    sessionId,
    content: [{ type: 'text', text: 'hello' }],
    timestamp: Date.now(),
    raw: {},
  };
}

describe('SessionStateManager', () => {
  it('reuses existing active session for same backend/channel/user', () => {
    const manager = new SessionStateManager(60_000);
    manager.upsert({
      backendName: 'claude-code',
      sessionId: 'session-old',
      requestId: 'req-1',
      message: mockMessage('session-old'),
      channelAdapter: mockChannelAdapter(),
      responseTimeoutMs: 5_000,
      onResponseTimeout: async () => undefined,
    });

    const resolved = manager.resolveReusableSessionId({
      backendName: 'claude-code',
      channel: 'feishu',
      channelUserId: 'user-1',
      fallbackSessionId: 'session-new',
    });
    expect(resolved).toBe('session-old');
  });

  it('resolves inbound route by channel/channelUserId without sessionId', () => {
    const manager = new SessionStateManager(60_000);
    manager.upsert({
      backendName: 'hermes',
      sessionId: 'session-1',
      requestId: 'req-1',
      message: mockMessage('session-1'),
      channelAdapter: mockChannelAdapter(),
      responseTimeoutMs: 5_000,
      onResponseTimeout: async () => undefined,
    });

    const state = manager.resolveInboundState({
      backendName: 'hermes',
      channel: 'feishu',
      channelUserId: 'user-1',
    });
    expect(state?.sessionId).toBe('session-1');
  });
});
