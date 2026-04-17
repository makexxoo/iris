#!/usr/bin/env node
import WebSocket from 'ws';
import { parseArgs } from 'node:util';
import { SessionManager } from './session';
import { handleIrisMessage, type ReplyContent } from './gateway';
import type { HermesConfig, IrisWsMessage } from './hermes';
import { logger } from './logger';

const { values } = parseArgs({
  options: {
    'iris-ws': { type: 'string' },
    'hermes-url': { type: 'string' },
    'hermes-key': { type: 'string' },
    'hermes-model': { type: 'string' },
    timeout: { type: 'string' },
  },
  strict: false,
});

const irisWs = values['iris-ws'] as string | undefined;
const hermesUrl = (values['hermes-url'] as string | undefined) ?? process.env.HERMES_URL;
const hermesKey = (values['hermes-key'] as string | undefined) ?? process.env.HERMES_API_KEY;
const hermesModel = (values['hermes-model'] as string | undefined) ?? process.env.HERMES_MODEL;
const timeoutMs = Number(values['timeout'] ?? process.env.HERMES_TIMEOUT_MS ?? 300_000);

if (!irisWs) {
  console.error(
    'Usage: hermes-plugin --iris-ws <ws-url> [--hermes-url <url>] [--hermes-key <key>]\n' +
      '  --iris-ws      iris WS endpoint, e.g. ws://localhost:9527/ws/hermes\n' +
      '  --hermes-url   hermes-agent api_server base URL (default: http://localhost:8642)\n' +
      '  --hermes-key   API_SERVER_KEY set in hermes-agent (optional)\n' +
      '  --hermes-model model name to pass (default: hermes)\n' +
      '  --timeout      reply timeout in ms (default: 300000)\n' +
      '\n' +
      'Env vars: HERMES_URL, HERMES_API_KEY, HERMES_MODEL, HERMES_TIMEOUT_MS',
  );
  process.exit(1);
}

if (!hermesUrl) {
  console.error('hermes-url is required. Pass --hermes-url or set HERMES_URL.');
  process.exit(1);
}

const hermesConfig: HermesConfig = {
  baseUrl: hermesUrl,
  apiKey: hermesKey,
  model: hermesModel,
  timeoutMs,
};

const sessionManager = new SessionManager();

logger.info({ irisWs, hermesUrl }, 'plugin-hermes starting');

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
      hermesConfig,
      sendReply: (sessionId: string, content: ReplyContent) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', sessionId, content }));
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
    // 'close' fires after this — reconnect handled there
  });
}

connect();
