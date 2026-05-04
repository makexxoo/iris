export type MessageType = 'message' | 'message_update';

export type MessageContentPart =
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
  | {
      type: 'input_audio';
      input_audio: {
        data: string;
        format?: string;
      };
    }
  | {
      type: 'file';
      file: {
        file_id?: string;
        filename?: string;
        file_data?: string;
        mimetype?: string;
      };
    };

export interface IrisMessage {
  id: string;
  type: MessageType;
  channelType: string;
  channelName: string;
  channelUserId: string;
  sessionId: string;
  content: MessageContentPart[];
  timestamp: number;
  raw: unknown;
  context?: Record<string, unknown>;
}

export function extractTextFromContentParts(parts: MessageContentPart[]): string {
  return parts
    .filter((part): part is Extract<MessageContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
