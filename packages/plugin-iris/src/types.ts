export const BACKEND_PROTOCOL_VERSION = 2 as const;

export type EnvelopeType = 'message' | 'message_update';

export interface MessageContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  attachments?: Array<{
    type: string;
    fileName?: string;
    mimeType?: string;
    url?: string;
    base64?: string;
  }>;
}

export interface InboundPayload {
  messageId: string;
  sessionId: string;
  channel: string;
  channelUserId: string;
  content: MessageContent;
  context?: Record<string, unknown>;
}

export interface OutboundPayload {
  channel: string;
  channelUserId: string;
  content: MessageContent;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
}

export interface Envelope<TPayload> {
  version: typeof BACKEND_PROTOCOL_VERSION;
  type: EnvelopeType;
  timestamp: number;
  traceId?: string;
  payload: TPayload;
}

export type IrisInboundEnvelope = Envelope<InboundPayload>;
export type IrisOutboundEnvelope = Envelope<OutboundPayload>;

export interface IrisInboundMessage {
  sessionId: string;
  requestId: string;
  channel: string;
  channelUserId: string;
  content: MessageContent;
  context: Record<string, unknown>;
  traceId?: string;
}

export type HandlerReply = string | MessageContent | null | undefined;

export interface IrisMessageHandler {
  (message: IrisInboundMessage): Promise<HandlerReply> | HandlerReply;
}
