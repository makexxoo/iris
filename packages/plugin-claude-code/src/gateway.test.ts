import { describe, it, expect, mock } from 'bun:test';
import { handleIrisMessage, type IrisWsMessage } from './gateway';
import { SessionManager } from './session';

// Mock the Claude Code SDK
const mockQuery = mock(async function* () {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-sess-abc' };
  yield { type: 'result', subtype: 'success', result: 'Hello from Claude Code' };
});

mock.module('@anthropic-ai/claude-code', () => ({
  query: mockQuery,
}));

function makeMsg(overrides: Partial<IrisWsMessage> = {}): IrisWsMessage {
  return {
    type: 'message',
    id: 'msg-1',
    channel: 'feishu',
    channelUserId: 'user-1',
    sessionId: 'feishu:user-1',
    content: [{ type: 'text', text: 'hello' }],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('handleIrisMessage', () => {
  it('calls sendReply with the Claude Code result', async () => {
    const mgr = new SessionManager();
    const replies: Array<{ sessionId: string; text: string }> = [];

    await new Promise<void>((resolve) => {
      handleIrisMessage({
        msg: makeMsg(),
        sessionManager: mgr,
        cwd: '/tmp',
        sendReply: (sessionId, text) => {
          replies.push({ sessionId, text });
          resolve();
        },
      });
      // drain happens async via enqueue
    });

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe('Hello from Claude Code');
    expect(replies[0].sessionId).toBe('feishu:user-1');
  });

  it('stores the SDK session ID for subsequent messages', async () => {
    const mgr = new SessionManager();

    await new Promise<void>((resolve) => {
      handleIrisMessage({
        msg: makeMsg(),
        sessionManager: mgr,
        cwd: '/tmp',
        sendReply: () => resolve(),
      });
    });

    const state = mgr.getOrCreate('feishu:user-1');
    expect(state.sdkSessionId).toBe('sdk-sess-abc');
  });

  it('skips sendReply for empty message text', async () => {
    const mgr = new SessionManager();
    const replies: string[] = [];

    handleIrisMessage({
      msg: makeMsg({ content: [{ type: 'text', text: '' }] }),
      sessionManager: mgr,
      cwd: '/tmp',
      sendReply: (_, text) => {
        replies.push(text);
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(replies).toHaveLength(0);
  });
});
