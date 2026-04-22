#!/usr/bin/env node
import WebSocket from 'ws';
import { parseArgs } from 'node:util';
import { type IrisMessage, type MessageContentPart } from '@agent-iris/protocol';
import { SessionManager } from './session';
import { handleIrisMessage, type IrisWsMessage } from './gateway';
import { logger } from './logger';

const { values } = parseArgs({
  options: {
    'iris-ws': { type: 'string' },
    cwd: { type: 'string' },
    timeout: { type: 'string' },
  },
  strict: false,
});

const irisWs = values['iris-ws'] as string | undefined;
if (!irisWs) {
  console.error('Usage: claude-code-channel --iris-ws <ws-url> [--cwd <dir>]');
  process.exit(1);
}

const cwd = (values['cwd'] as string | undefined) ?? process.cwd();
const sessionManager = new SessionManager();
logger.info({ irisWs, cwd }, 'claude-code-channel starting');

function normalizeContentParts(content: unknown): MessageContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is MessageContentPart => {
    return !!part && typeof part === 'object' && 'type' in part;
  });
}

function connect(): void {
  const ws = new WebSocket(irisWs as string);

  ws.on('open', () => {
    logger.info({ irisWs }, 'connected to iris');
  });

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const payload = msg as Partial<IrisMessage>;
    if (payload.type !== 'message') return;

    handleIrisMessage({
      msg: {
        type: 'message',
        id: String(payload.id ?? ''),
        channel: String(payload.channel ?? ''),
        channelUserId: String(payload.channelUserId ?? ''),
        sessionId: String(payload.sessionId ?? ''),
        content: normalizeContentParts(payload.content),
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
        raw: payload.raw ?? { source: 'plugin-claude-code-inbound' },
        context:
          payload.context && typeof payload.context === 'object'
            ? (payload.context as Record<string, unknown>)
            : undefined,
      },
      sessionManager,
      cwd,
      sendReply: (sessionId, text) => {
        if (ws.readyState === WebSocket.OPEN) {
          const now = Date.now();
          ws.send(
            JSON.stringify(<IrisMessage>{
              id: `reply-${now}`,
              type: 'message',
              sessionId,
              channel: String(payload.channel ?? ''),
              channelUserId: String(payload.channelUserId ?? ''),
              content: [{ type: 'text', text }],
              timestamp: now,
              raw: { source: 'plugin-claude-code' },
            }),
          );
        }
      },
    });
  });

  ws.on('close', () => {
    logger.info('disconnected from iris — reconnecting in 5s');
    setTimeout(connect, 5_000);
  });

  ws.on('error', (err) => {
    logger.warn({ err }, 'WS error');
    // 'close' fires after this — reconnect is handled there
  });
}

connect();
