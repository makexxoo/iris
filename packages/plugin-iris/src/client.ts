import WebSocket from 'ws';
import { extractTextFromContentParts, type IrisMessage } from '@agent-iris/protocol';
import { logger } from './logger';
import {
  HandlerReply,
  IrisInboundEnvelope,
  IrisInboundMessage,
  IrisMessageHandler,
  IrisOutboundEnvelope,
  MessageContent,
} from './types';

export interface IrisPluginClientOptions {
  irisWs: string;
  handler: IrisMessageHandler;
  reconnectDelayMs?: number;
}

function normalizeReply(reply: HandlerReply): MessageContent | null {
  if (reply === null || reply === undefined) return null;
  if (typeof reply === 'string') return { type: 'text', text: reply };
  return reply;
}

function extractTextFromParts(parts: IrisInboundEnvelope['content']): string {
  return extractTextFromContentParts(parts);
}

function parseInboundEnvelope(raw: string): IrisInboundEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object') return null;
  const payload = decoded as Record<string, unknown>;
  if (payload['type'] !== 'message' && payload['type'] !== 'message_update') return null;
  if (
    typeof payload['id'] !== 'string' ||
    typeof payload['sessionId'] !== 'string' ||
    typeof payload['channel'] !== 'string' ||
    typeof payload['channelUserId'] !== 'string'
  ) {
    return null;
  }
  const content = payload['content'];
  if (!Array.isArray(content)) return null;
  return {
    id: payload['id'],
    type: payload['type'] === 'message_update' ? 'message_update' : 'message',
    sessionId: payload['sessionId'],
    channel: payload['channel'],
    channelUserId: payload['channelUserId'],
    content: content as IrisInboundEnvelope['content'],
    timestamp: typeof payload['timestamp'] === 'number' ? (payload['timestamp'] as number) : Date.now(),
    raw: payload['raw'] ?? { source: 'plugin-iris-inbound' },
    context:
      payload['context'] && typeof payload['context'] === 'object'
        ? (payload['context'] as Record<string, unknown>)
        : undefined,
  };
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
    const ws = new WebSocket(this.options.irisWs);
    this.ws = ws;

    ws.on('open', () => {
      logger.info({ irisWs: this.options.irisWs }, 'connected to iris backend');
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

    ws.on('error', (err) => {
      logger.warn({ err }, 'plugin-iris websocket error');
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    const message = parseInboundEnvelope(raw);
    if (!message) return;

    const inbound: IrisInboundMessage = {
      sessionId: message.sessionId,
      requestId: message.id,
      channel: message.channel,
      channelUserId: message.channelUserId,
      content: { type: 'text', text: extractTextFromParts(message.content) },
      context: message.context ?? {},
      raw: message.raw,
      parts: message.content,
    };

    let reply: HandlerReply;
    try {
      reply = await this.options.handler(inbound);
    } catch (err) {
      logger.error({ err, sessionId: inbound.sessionId }, 'plugin handler failed');
      reply = `plugin-iris handler error: ${String(err)}`;
    }

    const normalized = normalizeReply(reply);
    if (!normalized) return;

    this.send({
      id: inbound.requestId,
      type: 'message',
      sessionId: inbound.sessionId,
      channel: inbound.channel,
      channelUserId: inbound.channelUserId,
      content: [{ type: 'text', text: normalized.text ?? '' }],
      timestamp: Date.now(),
      raw: { source: 'plugin-iris' },
    });
  }

  send(envelope: IrisOutboundEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('skip sending outbound message: websocket not open');
      return;
    }
    this.ws.send(JSON.stringify(envelope));
  }
}
