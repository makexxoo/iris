import type { BackendRequest, MessageAttachment, MessageContent, MessageContentPart } from '../message';
import type { InboundReplyMessage } from './session-routed-ws-backend';

type WsFrameType = 'message' | 'reply' | 'reply_update' | 'error';

export interface WsBackendFrame {
  type: WsFrameType;
  id?: string;
  sessionId: string;
  requestId?: string;
  timestamp?: number;
  content?: MessageContentPart[];
  text?: string;
  context?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export function buildOutboundWsMessage(
  req: BackendRequest,
  meta?: Record<string, unknown>,
): string {
  const { message } = req;
  const content = toProtocolContentParts(message.content);
  return JSON.stringify({
    type: 'message',
    id: message.id,
    sessionId: message.sessionId,
    requestId: message.id,
    timestamp: message.timestamp,
    content,
    context: req.context,
    meta: {
      channel: message.channel,
      channelUserId: message.channelUserId,
      ...(meta ?? {}),
    },
  } satisfies WsBackendFrame);
}

export function parseInboundWsReply(raw: string): InboundReplyMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;
  const type = msg['type'];
  if (type !== 'reply' && type !== 'reply_update') return null;

  const sessionId = msg['sessionId'];
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const requestId = normalizeOptionalString(msg['requestId'] ?? msg['replyTo'] ?? msg['messageId']);

  // Compatibility mode: old protocol used `text` only.
  if (!Array.isArray(msg['content'])) {
    return {
      type,
      sessionId,
      requestId,
      content: { type: 'text', text: normalizeOptionalString(msg['text']) ?? '' },
    };
  }

  const parts = msg['content'].filter(isRecord).map(normalizePart).filter(Boolean) as MessageContentPart[];
  return {
    type,
    sessionId,
    requestId,
    content: fromProtocolContentParts(parts),
  };
}

export function toProtocolContentParts(content: MessageContent): MessageContentPart[] {
  if (Array.isArray(content.parts) && content.parts.length > 0) return content.parts;

  const parts: MessageContentPart[] = [];
  if (content.text) {
    parts.push({ type: 'input_text', text: content.text });
  }

  for (const attachment of content.attachments ?? []) {
    if (attachment.type === 'image') {
      const url = toAttachmentUrl(attachment);
      if (url) {
        parts.push({
          type: 'input_image',
          image_url: { url, detail: attachment.fileName },
        });
      }
      continue;
    }

    const filePart: MessageContentPart = {
      type: 'input_file',
      filename: attachment.fileName,
      mime_type: attachment.mimeType,
    };
    if (attachment.url) filePart.file_url = attachment.url;
    if (attachment.base64) filePart.file_data = attachment.base64;
    parts.push(filePart);
  }

  return parts;
}

export function fromProtocolContentParts(parts: MessageContentPart[]): MessageContent {
  const text = parts
    .filter((part): part is Extract<MessageContentPart, { type: 'input_text' | 'output_text' }> =>
      part.type === 'input_text' || part.type === 'output_text',
    )
    .map((part) => part.text)
    .join('');
  const attachments: MessageAttachment[] = [];

  for (const part of parts) {
    if (part.type === 'input_image') {
      const image = part.image_url;
      if (!image?.url) continue;
      const dataInfo = parseDataUrl(image.url);
      attachments.push({
        type: 'image',
        fileName: image.detail,
        mimeType: dataInfo?.mimeType,
        base64: dataInfo?.base64,
        url: dataInfo ? undefined : image.url,
      });
      continue;
    }

    if (part.type === 'input_file') {
      attachments.push({
        type: 'file',
        fileName: part.filename,
        mimeType: part.mime_type,
        base64: part.file_data,
        url: part.file_url,
      });
    }
  }

  const firstAttachmentType = attachments[0]?.type;
  return {
    type: text ? 'text' : firstAttachmentType ?? 'text',
    text: text || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    parts,
  };
}

function normalizePart(part: Record<string, unknown>): MessageContentPart | null {
  const type = normalizeOptionalString(part['type']);
  if (!type) return null;

  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    return { type: type === 'output_text' ? 'output_text' : 'input_text', text: String(part['text'] ?? '') };
  }

  if (type === 'input_image') {
    const image = part['image_url'];
    if (!isRecord(image) || typeof image['url'] !== 'string') return null;
    return {
      type: 'input_image',
      image_url: {
        url: image['url'],
        detail: normalizeOptionalString(image['detail']),
      },
    };
  }

  // Hermes legacy content part compatibility.
  if (type === 'image_url') {
    const image = part['image_url'];
    if (!isRecord(image) || typeof image['url'] !== 'string') return null;
    return {
      type: 'input_image',
      image_url: {
        url: image['url'],
        detail: normalizeOptionalString(image['detail']),
      },
    };
  }

  if (type === 'input_file' || type === 'file') {
    return {
      type: 'input_file',
      file_url: normalizeOptionalString(part['file_url']),
      file_data: normalizeOptionalString(part['file_data']),
      mime_type: normalizeOptionalString(part['mime_type']),
      filename: normalizeOptionalString(part['filename']),
    };
  }
  return null;
}

function toAttachmentUrl(attachment: MessageAttachment): string | undefined {
  if (attachment.url) return attachment.url;
  if (attachment.base64 && attachment.mimeType) {
    return `data:${attachment.mimeType};base64,${attachment.base64}`;
  }
  return undefined;
}

function parseDataUrl(url: string): { mimeType?: string; base64: string } | null {
  if (!url.startsWith('data:')) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) return null;
  const meta = url.slice(0, commaIndex);
  const base64 = url.slice(commaIndex + 1);
  const mimeType = meta.replace('data:', '').replace(';base64', '') || undefined;
  return { mimeType, base64 };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}
