#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { IrisPluginClient } from './client';
import { logger } from './logger';
import { IrisMessage } from '@agent-iris/protocol';

const { values } = parseArgs({
  options: {
    'iris-ws': { type: 'string' },
    mode: { type: 'string' },
    prefix: { type: 'string' },
    reconnect: { type: 'string' },
  },
  strict: false,
});

const irisWs = (values['iris-ws'] as string | undefined) ?? process.env.IRIS_WS;
if (!irisWs) {
  console.error(
    'Usage: plugin-iris --iris-ws <ws-url> [--mode echo] [--prefix "[iris] "] [--reconnect 5000]\n' +
      'Env: IRIS_WS',
  );
  process.exit(1);
}

const mode = (
  (values['mode'] as string | undefined) ??
  process.env.PLUGIN_IRIS_MODE ??
  'echo'
).trim();
const reconnectDelayMs = Number(
  values['reconnect'] ?? process.env.PLUGIN_IRIS_RECONNECT_MS ?? 5000,
);

logger.info({ irisWs, mode, reconnectDelayMs }, 'starting plugin-iris');

const client = new IrisPluginClient({
  irisWs,
  reconnectDelayMs,
  handler: async (msg) => {
    if (mode === 'echo') {
      echoReply(msg);
      return;
    }
    logger.warn({ mode }, 'unknown mode, fallback to echo');
    echoReply(msg);
  },
});
function echoReply(msg: IrisMessage) {
  client?.send(msg);
}

client.start();

process.on('SIGINT', () => {
  client.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.stop();
  process.exit(0);
});
