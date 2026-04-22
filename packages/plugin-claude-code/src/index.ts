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
const protocolVersion = 2;

logger.info({ irisWs, cwd }, 'claude-code-channel starting');

function readInboundTextFromContentParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => {
      return !!part && typeof part === 'object' && (part as { type?: string }).type === 'text';
    })
    .map((part) => part.text ?? '')
    .join('');
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

    const m = msg as Record<string, unknown>;
    if (m['type'] !== 'message') return;
    const payload =
      m['payload'] && typeof m['payload'] === 'object'
        ? (m['payload'] as Record<string, unknown>)
        : null;
    if (!payload) return;

    handleIrisMessage({
      msg: {
        type: 'message',
        id: String(payload['id'] ?? ''),
        channel: String(payload['channel'] ?? ''),
        channelUserId: String(payload['channelUserId'] ?? ''),
        sessionId: String(payload['sessionId'] ?? ''),
        content: [{ type: 'text', text: readInboundTextFromContentParts(payload['content']) }],
        timestamp: typeof m['timestamp'] === 'number' ? (m['timestamp'] as number) : Date.now(),
        context:
          m['context'] && typeof m['context'] === 'object'
            ? (m['context'] as Record<string, unknown>)
            : undefined,
      },
      sessionManager,
      cwd,
      sendReply: (sessionId, text) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              version: protocolVersion,
              type: 'message',
              timestamp: Date.now(),
              payload: {
                sessionId,
                channel: String(payload['channel'] ?? ''),
                channelUserId: String(payload['channelUserId'] ?? ''),
                content: [{ type: 'text', text }],
              },
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
