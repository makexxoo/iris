#!/usr/bin/env node
import WebSocket from 'ws';
import { parseArgs } from 'node:util';
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

    const m = msg as Record<string, unknown>;
    if (m['type'] !== 'message') return;

    handleIrisMessage({
      msg: m as unknown as IrisWsMessage,
      sessionManager,
      cwd,
      sendReply: (sessionId, text) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', sessionId, text }));
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
