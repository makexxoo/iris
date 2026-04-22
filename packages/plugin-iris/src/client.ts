import WebSocket from 'ws';
import { IrisMessage } from '@agent-iris/protocol';
import type { IncomingMessage } from 'http';
import { logger } from './logger';
import { IrisMessageHandler } from './types';

export interface IrisPluginClientOptions {
  irisWs: string;
  handler: IrisMessageHandler;
  reconnectDelayMs?: number;
}

function normalizeWsUrl(raw: string): string {
  const input = raw.trim();
  if (!input) return input;
  try {
    const url = new URL(input);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    return url.toString();
  } catch {
    return input;
  }
}

export class IrisPluginClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly reconnectDelayMs: number;

  constructor(private readonly options: IrisPluginClientOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const wsUrl = normalizeWsUrl(this.options.irisWs);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      logger.info({ irisWs: wsUrl }, 'connected to iris backend');
    });

    ws.on('message', (raw) => {
      void this.handleRawMessage(raw.toString());
    });

    ws.on('close', () => {
      logger.info({ delayMs: this.reconnectDelayMs }, 'disconnected from iris, reconnecting');
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.reconnectDelayMs);
      }
    });

    ws.on('unexpected-response', (_req, res: IncomingMessage) => {
      logger.warn(
        {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          irisWs: wsUrl,
        },
        'plugin-iris websocket unexpected-response',
      );
    });

    ws.on('error', (err) => {
      logger.warn({ err, irisWs: wsUrl }, 'plugin-iris websocket error');
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let message: IrisMessage | undefined;
    try {
      message = JSON.parse(raw) as IrisMessage;
    } catch (err) {
      logger.error({ err, message: raw }, 'parse message failed');
      return;
    }

    if (!message) return;

    try {
      await this.options.handler(message);
    } catch (err) {
      logger.error({ err, sessionId: message.id }, 'plugin handler failed');
      const reply = `plugin-iris handler error: ${String(err)}`;
      this.send({
        id: `${message.id}_reply`,
        type: 'message',
        channel: message.channel,
        channelUserId: message.channelUserId,
        content: [
          {
            type: 'text',
            text: reply,
          },
        ],
        raw: undefined,
        sessionId: message.sessionId,
        timestamp: Date.now(),
      });
    }
  }

  send(envelope: IrisMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('skip sending outbound message: websocket not open');
      return;
    }
    this.ws.send(JSON.stringify(envelope));
  }
}
