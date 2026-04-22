#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { IrisPluginClient } from './client';
import { logger } from './logger';
import { IrisInboundMessage } from './types';

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

const mode = ((values['mode'] as string | undefined) ?? process.env.PLUGIN_IRIS_MODE ?? 'echo').trim();
const prefix =
  (values['prefix'] as string | undefined) ?? process.env.PLUGIN_IRIS_PREFIX ?? '[plugin-iris] ';
const reconnectDelayMs = Number(values['reconnect'] ?? process.env.PLUGIN_IRIS_RECONNECT_MS ?? 5000);

function buildEchoReply(msg: IrisInboundMessage): string {
  const text = msg.content.text ?? '';
  return `${prefix}${text}`;
}

logger.info({ irisWs, mode, reconnectDelayMs }, 'starting plugin-iris');

const client = new IrisPluginClient({
  irisWs,
  reconnectDelayMs,
  handler: async (msg) => {
    if (mode === 'echo') return buildEchoReply(msg);
    logger.warn({ mode }, 'unknown mode, fallback to echo');
    return buildEchoReply(msg);
  },
});

client.start();

process.on('SIGINT', () => {
  client.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.stop();
  process.exit(0);
});
