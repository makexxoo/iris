import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer } from 'http';
import WebSocket from 'ws';
import { ClaudeCodeChannelBackend } from './adapter';
import type { BackendRequest } from '@agent-iris/core';

function makeRequest(sessionId: string): BackendRequest {
  return {
    message: {
      id: 'msg-1',
      channel: 'feishu',
      channelUserId: 'user-1',
      sessionId,
      content: { type: 'text', text: 'hello' },
      timestamp: Date.now(),
      raw: {},
    },
    context: {},
  };
}

describe('ClaudeCodeChannelBackend', () => {
  let backend: ClaudeCodeChannelBackend;
  let httpServer: ReturnType<typeof createServer>;

  beforeEach(async () => {
    backend = new ClaudeCodeChannelBackend({ timeoutMs: 500 });
    httpServer = createServer();
    backend.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  });

  afterEach(async () => {
    backend.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('resolves chat() when CLI sends reply', async () => {
    const port = (httpServer.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/claude-code`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const chatPromise = backend.chat(makeRequest('session-1'));

    // Simulate CLI sending back a reply
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({ type: 'reply', sessionId: 'session-1', text: 'hello back' }));

    const result = await chatPromise;
    expect(result).toEqual({ type: 'text', text: 'hello back' });
    ws.close();
  });

  it('rejects chat() after timeout', async () => {
    const port = (httpServer.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/claude-code`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    await expect(backend.chat(makeRequest('session-timeout'))).rejects.toThrow('timeout');
    ws.close();
  });

  it('rejects chat() when no CLI connected', async () => {
    await expect(backend.chat(makeRequest('session-no-cli'))).rejects.toThrow(
      'no connected claude-code-channel',
    );
  });
});
