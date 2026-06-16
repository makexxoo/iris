import pino from 'pino';
import type { ChannelAdapter, IrisMessage, MessageHandler } from '@agent-iris/core';
import { extractTextFromContentParts } from '@agent-iris/core';
import { BotConnection, type TelegramBotConfig } from './bot-connection.js';

type RegisterServer = Parameters<ChannelAdapter['register']>[0];

const logger = pino({ name: 'channel-telegram:adapter' });

/** Supported Telegram parse_mode values for formatted text. */
type ParseMode = 'MarkdownV2' | 'HTML' | 'Markdown';

/**
 * Resolve the Telegram parse_mode from IrisMessage.extra.
 * Checks common keys: format, contentType, parseMode, parse_mode.
 * Maps 'markdown' / 'md' → MarkdownV2, 'html' → HTML.
 */
function resolveParseMode(extra?: Record<string, unknown>): ParseMode | undefined {
  if (!extra) return undefined;

  const formatHint = (
    extra.format ??
    extra.contentType ??
    extra.parseMode ??
    extra.parse_mode ??
    ''
  ).toString().toLowerCase();

  if (formatHint === 'markdown' || formatHint === 'md' || formatHint === 'markdownv2') {
    return 'MarkdownV2';
  }
  if (formatHint === 'html') {
    return 'HTML';
  }
  return undefined;
}

export interface TelegramConfig extends TelegramBotConfig {
  /** Channel instance name (e.g. 'telegram-main'). Used for routing. */
  name?: string;
  enabled?: boolean;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type: string = 'telegram';
  readonly name: string;
  private readonly connection: BotConnection;
  /**
   * Buffer for streaming message_update chunks.
   * Keyed by IrisMessage.id — accumulates all text content until the final
   * message arrives, then flushed as a single sendMessage.
   */
  private readonly streamBuffer = new Map<string, string>();

  constructor(config: TelegramConfig, messageHandler: MessageHandler) {
    this.name = config.name ?? 'telegram';
    this.connection = new BotConnection(config, this.name, messageHandler);
  }

  support(message: IrisMessage): boolean {
    return message.channelType === this.type && message.channelName === this.name;
  }

  register(_server: RegisterServer): void {
    this.connection.start();
  }

  async reply(message: IrisMessage): Promise<void> {
    const chatId = message.sessionId.replace('telegram:', '');
    if (!chatId) {
      logger.error({ channelUserId: message.channelUserId }, 'telegram: no chatId');
      return;
    }

    // Typing indicator
    if (message.type === 'typing') {
      const action = (message.content?.[0] as any)?.text ?? 'typing';
      await this.connection.sendChatAction(chatId, action);
      return;
    }

    // --- Streaming: buffer the chunk, don't send yet ---
    if (message.type === 'message_update') {
      const text = extractTextFromContentParts(message.content ?? []);
      if (text) {
        this.streamBuffer.set(message.id, text);
      }
      return;
    }

    // --- Final message: flush buffer + send ---
    const buffered = this.streamBuffer.get(message.id);
    this.streamBuffer.delete(message.id);

    // Use the final message's text if available, otherwise the last buffered chunk
    const finalText = extractTextFromContentParts(message.content ?? []);
    const text = finalText || buffered;
    if (text) {
      const parseMode = resolveParseMode(message.extra);
      await this.connection.sendText(chatId, text, parseMode);
    }

    // Non-text content parts
    for (const part of message.content ?? []) {
      await this._sendContentPart(chatId, part);
    }
  }

  // ---------------------------------------------------------------------------
  // Content part helpers
  // ---------------------------------------------------------------------------

  private async _sendContentPart(chatId: string, part: any): Promise<void> {
    try {
      if (part.type === 'image_url' && part.image_url.url.startsWith('data:')) {
        const comma = part.image_url.url.indexOf(',');
        if (comma < 0) return;
        const buf = Buffer.from(part.image_url.url.slice(comma + 1), 'base64');
        await this.connection.sendPhoto(chatId, buf, part.image_url.detail);
      } else if (part.type === 'input_audio') {
        const buf = Buffer.from(part.input_audio.data, 'base64');
        await this.connection.sendDocument(chatId, buf, 'audio.ogg');
      } else if (part.type === 'file' && part.file.file_data) {
        const buf = Buffer.from(part.file.file_data, 'base64');
        await this.connection.sendDocument(chatId, buf, part.file.filename ?? 'file');
      }
    } catch (err) {
      logger.error({ err }, 'telegram: failed to send content part');
    }
  }
}
