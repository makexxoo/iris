import WebSocket from 'ws';
import { logger } from './logger';
import {
  BACKEND_PROTOCOL_VERSION,
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

function extractTextFromParts(
  parts: IrisInboundEnvelope['payload']['content'],
): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => {
      return !!part && typeof part === 'object' && part.type === 'text';
    })
    .map((part) => part.text ?? '')
    .join('');
}

function parseInboundEnvelope(raw: string): IrisInboundEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object') return null;
  const envelope = decoded as Record<string, unknown>;
  if (envelope['version'] !== BACKEND_PROTOCOL_VERSION) return null;
  if (envelope['type'] !== 'message') return null;
  const payload =
    envelope['payload'] && typeof envelope['payload'] === 'object'
      ? (envelope['payload'] as Record<string, unknown>)
      : null;
  if (!payload) return null;
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
    version: BACKEND_PROTOCOL_VERSION,
    type: 'message',
    timestamp: typeof envelope['timestamp'] === 'number' ? (envelope['timestamp'] as number) : Date.now(),
    traceId: typeof envelope['traceId'] === 'string' ? (envelope['traceId'] as string) : undefined,
    payload: {
      id: payload['id'],
      sessionId: payload['sessionId'],
      channel: payload['channel'],
      channelUserId: payload['channelUserId'],
      content: content as IrisInboundEnvelope['payload']['content'],
      timestamp:
        typeof payload['timestamp'] === 'number' ? (payload['timestamp'] as number) : Date.now(),
      raw: payload['raw'],
    },
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
    const envelope = parseInboundEnvelope(raw);
    if (!envelope) return;

    const inbound: IrisInboundMessage = {
      sessionId: envelope.payload.sessionId,
      requestId: envelope.payload.id,
      channel: envelope.payload.channel,
      channelUserId: envelope.payload.channelUserId,
      content: { type: 'text', text: extractTextFromParts(envelope.payload.content) },
      context: {},
      traceId: envelope.traceId,
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
      version: BACKEND_PROTOCOL_VERSION,
      type: 'message',
      timestamp: Date.now(),
      traceId: inbound.traceId,
      payload: {
        id: inbound.requestId,
        sessionId: inbound.sessionId,
        channel: inbound.channel,
        channelUserId: inbound.channelUserId,
        content: [{ type: 'text', text: normalized.text ?? '' }],
        timestamp: Date.now(),
      },
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
