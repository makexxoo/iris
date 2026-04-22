export const BACKEND_PROTOCOL_VERSION = 2 as const;

export type EnvelopeType = 'message' | 'message_update';

export interface MessageContent {
  type: 'text';
  text: string;
}

export interface InboundPayload {
  id: string;
  sessionId: string;
  channel: string;
  channelUserId: string;
  content: Array<
    | {
        type: 'text';
        text: string;
      }
    | {
        type: 'image_url';
        image_url: {
          url: string;
          detail?: string;
        };
      }
  >;
  timestamp: number;
  raw?: unknown;
}

export interface OutboundPayload {
  id: string;
  sessionId: string;
  channel: string;
  channelUserId: string;
  content: Array<
    | {
        type: 'text';
        text: string;
      }
    | {
        type: 'image_url';
        image_url: {
          url: string;
          detail?: string;
        };
      }
  >;
  timestamp: number;
  raw?: unknown;
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
