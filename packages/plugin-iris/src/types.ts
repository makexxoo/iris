import type { IrisMessage, MessageContentPart } from '@agent-iris/protocol';

export interface MessageContent {
  type: 'text';
  text: string;
}

export type IrisInboundEnvelope = IrisMessage;
export type IrisOutboundEnvelope = IrisMessage;

export interface IrisInboundMessage {
  sessionId: string;
  requestId: string;
  channel: string;
  channelUserId: string;
  content: MessageContent;
  context: Record<string, unknown>;
  traceId?: string;
  raw?: unknown;
  parts?: MessageContentPart[];
}

export type HandlerReply = string | MessageContent | null | undefined;

export interface IrisMessageHandler {
  (message: IrisInboundMessage): Promise<HandlerReply> | HandlerReply;
}
