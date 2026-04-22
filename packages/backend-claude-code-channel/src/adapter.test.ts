import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer } from 'http';
import WebSocket from 'ws';
import { ClaudeCodeChannelBackend } from './adapter';
import {
  SessionStateManager,
  extractTextFromContentParts,
  type BackendRequest,
  type ChannelAdapter,
  type IrisMessage,
} from '@agent-iris/core';

function makeRequest(
  sessionId: string,
  onReply?: (message: IrisMessage) => void,
): BackendRequest & { channelAdapter: ChannelAdapter } {
  return {
    message: {
      id: 'msg-1',
      type: 'message',
      channel: 'feishu',
      channelUserId: 'user-1',
      sessionId,
      content: [{ type: 'text', text: 'hello' }],
      timestamp: Date.now(),
      raw: {},
    },
    context: {},
    channelAdapter: {
      name: 'mock-channel',
      support: () => true,
      register: () => undefined,
      reply: async (message) => onReply?.(message),
    },
  };
}

describe('ClaudeCodeChannelBackend', () => {
  let backend: ClaudeCodeChannelBackend;
  let httpServer: ReturnType<typeof createServer>;

  beforeEach(async () => {
    backend = new ClaudeCodeChannelBackend({ timeoutMs: 500 }, new SessionStateManager(60_000));
    httpServer = createServer();
    backend.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  });

  afterEach(async () => {
    backend.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('forwards CLI reply via channelAdapter.reply()', async () => {
    const port = (httpServer.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/claude-code`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    let replyText = '';
    await backend.chat(
      makeRequest('session-1', (message) => {
        replyText = extractTextFromContentParts(message.content);
      }),
    );

    // Simulate CLI sending back a reply
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    ws.send(
      JSON.stringify({
        id: 'reply-1',
        type: 'message',
        timestamp: Date.now(),
        sessionId: 'session-1',
        channel: 'feishu',
        channelUserId: 'user-1',
        content: [{ type: 'text', text: 'hello back' }],
        raw: {},
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(replyText).toEqual('hello back');
    ws.close();
  });

  it('sends timeout text via channelAdapter.reply()', async () => {
    const port = (httpServer.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/claude-code`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    let replyText = '';
    await backend.chat(
      makeRequest('session-timeout', (message) => {
        replyText = extractTextFromContentParts(message.content);
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 550));

    expect(replyText).toContain('timeout');
    ws.close();
  });

  it('rejects chat() when no CLI connected', async () => {
    await expect(backend.chat(makeRequest('session-no-cli'))).rejects.toThrow(
      'no connected plugin-claude-code instance',
    );
  });
});
