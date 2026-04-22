import { MessageContent } from '../message';

export const BACKEND_PROTOCOL_VERSION = 2 as const;

export type BackendEnvelopeType = 'message' | 'message_update';

export interface BackendEnvelope<TType extends BackendEnvelopeType, TPayload> {
  version: typeof BACKEND_PROTOCOL_VERSION;
  type: TType;
  timestamp: number;
  traceId?: string;
  payload: TPayload;
}

export interface BackendOutboundPayload {
  messageId: string;
  sessionId: string;
  channel: string;
  channelUserId: string;
  content: MessageContent;
  context: Record<string, unknown>;
}

export interface BackendInboundPayload {
  channel: string;
  channelUserId: string;
  content: MessageContent;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
}

export type BackendOutboundEnvelope = BackendEnvelope<'message', BackendOutboundPayload>;
export type BackendInboundEnvelope = BackendEnvelope<'message' | 'message_update', BackendInboundPayload>;

export const BackendProtocolErrorCode = {
  INVALID_JSON: 'BACKEND_PROTOCOL_INVALID_JSON',
  INVALID_ENVELOPE: 'BACKEND_PROTOCOL_INVALID_ENVELOPE',
  MISSING_VERSION: 'BACKEND_PROTOCOL_MISSING_VERSION',
  INVALID_VERSION: 'BACKEND_PROTOCOL_INVALID_VERSION',
  MISSING_TYPE: 'BACKEND_PROTOCOL_MISSING_TYPE',
  INVALID_TYPE: 'BACKEND_PROTOCOL_INVALID_TYPE',
  MISSING_PAYLOAD: 'BACKEND_PROTOCOL_MISSING_PAYLOAD',
  MISSING_CHANNEL: 'BACKEND_PROTOCOL_MISSING_CHANNEL',
  MISSING_CHANNEL_USER_ID: 'BACKEND_PROTOCOL_MISSING_CHANNEL_USER_ID',
  MISSING_CONTENT: 'BACKEND_PROTOCOL_MISSING_CONTENT',
} as const;

export type BackendProtocolErrorCode =
  (typeof BackendProtocolErrorCode)[keyof typeof BackendProtocolErrorCode];

export interface BackendProtocolValidationError {
  code: BackendProtocolErrorCode;
  message: string;
}

export interface ParseBackendInboundResult {
  envelope?: BackendInboundEnvelope;
  error?: BackendProtocolValidationError;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseContent(payload: Record<string, unknown>): MessageContent | null {
  const content = payload['content'];
  const contentRecord = asRecord(content);
  if (!contentRecord) return null;
  if (typeof contentRecord['type'] !== 'string') return null;
  return content as MessageContent;
}

export function parseBackendInboundEnvelope(raw: string): ParseBackendInboundResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      error: {
        code: BackendProtocolErrorCode.INVALID_JSON,
        message: 'backend inbound message is not valid JSON',
      },
    };
  }

  const envelope = asRecord(decoded);
  if (!envelope) {
    return {
      error: {
        code: BackendProtocolErrorCode.INVALID_ENVELOPE,
        message: 'backend inbound message must be an object envelope',
      },
    };
  }

  if (envelope['version'] === undefined) {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_VERSION,
        message: 'backend inbound envelope is missing version',
      },
    };
  }
  if (envelope['version'] !== BACKEND_PROTOCOL_VERSION) {
    return {
      error: {
        code: BackendProtocolErrorCode.INVALID_VERSION,
        message: `backend inbound envelope version must be ${BACKEND_PROTOCOL_VERSION}`,
      },
    };
  }

  const type = envelope['type'];
  if (typeof type !== 'string') {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_TYPE,
        message: 'backend inbound envelope is missing type',
      },
    };
  }
  if (type !== 'message' && type !== 'message_update') {
    return {
      error: {
        code: BackendProtocolErrorCode.INVALID_TYPE,
        message: 'backend inbound type must be message/message_update',
      },
    };
  }

  const payload = asRecord(envelope['payload']);
  if (!payload) {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_PAYLOAD,
        message: 'backend inbound envelope is missing payload object',
      },
    };
  }

  if (typeof payload['channel'] !== 'string' || !String(payload['channel']).trim()) {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_CHANNEL,
        message: 'backend inbound payload.channel is required',
      },
    };
  }

  if (
    typeof payload['channelUserId'] !== 'string' ||
    !String(payload['channelUserId']).trim()
  ) {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_CHANNEL_USER_ID,
        message: 'backend inbound payload.channelUserId is required',
      },
    };
  }

  const content = parseContent(payload);
  if (!content) {
    return {
      error: {
        code: BackendProtocolErrorCode.MISSING_CONTENT,
        message: 'backend inbound payload.content with content.type is required',
      },
    };
  }

  const inboundEnvelope: BackendInboundEnvelope = {
    version: BACKEND_PROTOCOL_VERSION,
    type,
    timestamp:
      typeof envelope['timestamp'] === 'number' ? (envelope['timestamp'] as number) : Date.now(),
    traceId: typeof envelope['traceId'] === 'string' ? (envelope['traceId'] as string) : undefined,
    payload: {
      channel: String(payload['channel']),
      channelUserId: String(payload['channelUserId']),
      content,
      sessionId: typeof payload['sessionId'] === 'string' ? (payload['sessionId'] as string) : undefined,
      requestId: typeof payload['requestId'] === 'string' ? (payload['requestId'] as string) : undefined,
      conversationId:
        typeof payload['conversationId'] === 'string'
          ? (payload['conversationId'] as string)
          : undefined,
    },
  };

  return { envelope: inboundEnvelope };
}
