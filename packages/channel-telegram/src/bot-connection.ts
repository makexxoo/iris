import { Bot, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import pino from 'pino';
import type { IrisMessage, MessageContentPart } from '@agent-iris/core';

const logger = pino({ name: 'channel-telegram:botconnection' });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramBotConfig {
  botToken: string;
  /** DM policy: 'open' (default), 'disabled', or 'allowlist' */
  dmPolicy?: 'open' | 'disabled' | 'allowlist';
  /** Group policy: 'disabled' (default), 'open', or 'allowlist' */
  groupPolicy?: 'open' | 'disabled' | 'allowlist';
  /** Allowed user IDs when dmPolicy is 'allowlist' */
  allowFrom?: string[];
  /** Allowed group/chat IDs when groupPolicy is 'allowlist' */
  groupAllowFrom?: string[];
}

// ---------------------------------------------------------------------------
// BotConnection
// ---------------------------------------------------------------------------

export class BotConnection {
  readonly botToken: string;
  private readonly bot: Bot;

  private readonly dmPolicy: 'open' | 'disabled' | 'allowlist';
  private readonly groupPolicy: 'open' | 'disabled' | 'allowlist';
  private readonly allowFrom: Set<string>;
  private readonly groupAllowFrom: Set<string>;

  constructor(
    config: TelegramBotConfig,
    private readonly channelName: string,
    private readonly onMessage: (msg: IrisMessage) => void,
  ) {
    this.botToken = config.botToken;
    this.bot = new Bot(config.botToken, {
      client: { timeoutSeconds: 15 },
    });
    this.dmPolicy = config.dmPolicy ?? 'open';
    this.groupPolicy = config.groupPolicy ?? 'disabled';
    this.allowFrom = new Set(config.allowFrom ?? []);
    this.groupAllowFrom = new Set(config.groupAllowFrom ?? []);

    // Register message handler
    this.bot.on('message', (ctx) => {
      this._handleMessage(ctx).catch((err) => {
        logger.error({ botToken: safeToken(this.botToken), err }, 'error handling message');
      });
    });

    // Global error handler
    this.bot.catch((err) => {
      logger.error({ botToken: safeToken(this.botToken), err }, 'grammY bot error');
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.bot.start({
      allowed_updates: ['message'],
    }).catch((err) => {
      logger.error({ botToken: safeToken(this.botToken), err }, 'poll loop exited unexpectedly');
    });
    logger.info({ botToken: safeToken(this.botToken) }, 'Telegram bot polling started (grammY)');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info({ botToken: safeToken(this.botToken) }, 'Telegram bot polling stopped');
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private async _handleMessage(ctx: { message: Message; update: { update_id: number } }): Promise<void> {
    const msg = ctx.message;

    const chat = msg.chat;
    const from = msg.from;
    if (!from || !chat) return;

    const chatId = String(chat.id);
    const fromId = String(from.id);

    // --- Policy gates ---
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';

    if (!isGroup && this.dmPolicy === 'disabled') return;
    if (!isGroup && this.dmPolicy === 'allowlist' && !this.allowFrom.has(fromId)) return;

    if (isGroup && this.groupPolicy === 'disabled') return;
    if (isGroup && this.groupPolicy === 'allowlist' && !this.groupAllowFrom.has(chatId)) return;

    // --- Parse content ---
    const content = await this._parseContent(msg);
    if (content.length === 0) return;

    this.onMessage({
      id: String(ctx.update.update_id),
      type: 'message',
      channelType: 'telegram',
      channelName: this.channelName,
      channelUserId: fromId,
      sessionId: `telegram:${chatId}`,
      content,
      timestamp: msg.date ? msg.date * 1000 : Date.now(),
      raw: msg,
    });
  }

  private async _parseContent(msg: Message): Promise<MessageContentPart[]> {
    const content: MessageContentPart[] = [];

    if (msg.text) {
      content.push({ type: 'text', text: msg.text });
    }

    if (msg.caption && !msg.text) {
      content.push({ type: 'text', text: msg.caption });
    }

    // Photo — use largest size
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      try {
        const dataUrl = await this._downloadAsDataUrl(largest.file_id, 'image/*');
        if (dataUrl) {
          content.push({
            type: 'image_url',
            image_url: { url: dataUrl, detail: largest.file_id },
          });
        }
      } catch (err) {
        logger.warn({ botToken: safeToken(this.botToken), err }, 'failed to download photo');
      }
    }

    // Document
    if (msg.document) {
      try {
        const dataUrl = await this._downloadAsDataUrl(
          msg.document.file_id,
          msg.document.mime_type ?? 'application/octet-stream',
        );
        if (dataUrl) {
          const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          content.push({
            type: 'file',
            file: {
              file_id: msg.document.file_id,
              filename: msg.document.file_name,
              file_data: b64,
              mimetype: msg.document.mime_type,
            },
          });
        }
      } catch (err) {
        logger.warn({ botToken: safeToken(this.botToken), err }, 'failed to download document');
      }
    }

    // Voice
    if (msg.voice) {
      try {
        const dataUrl = await this._downloadAsDataUrl(
          msg.voice.file_id,
          msg.voice.mime_type ?? 'audio/ogg',
        );
        if (dataUrl) {
          const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          content.push({
            type: 'input_audio',
            input_audio: { data: b64, format: msg.voice.mime_type ?? 'audio/ogg' },
          });
        }
      } catch (err) {
        logger.warn({ botToken: safeToken(this.botToken), err }, 'failed to download voice');
      }
    }

    return content;
  }

  // -------------------------------------------------------------------------
  // File helpers
  // -------------------------------------------------------------------------

  private async _downloadAsDataUrl(fileId: string, mimeType: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const res = await fetch(downloadUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const b64 = buf.toString('base64');
      return `data:${mimeType};base64,${b64}`;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound — send methods
  // -------------------------------------------------------------------------

  /**
   * Send a text message. Supports optional parse_mode for Markdown/HTML formatting.
   * If MarkdownV2 parsing fails (LLMs often produce Telegram-incompatible markdown),
   * automatically retries as plain text.
   */
  async sendText(
    chatId: string | number,
    text: string,
    parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown',
  ): Promise<{ message_id: number }> {
    if (!parseMode) {
      return await this.bot.api.sendMessage(chatId, text);
    }

    try {
      return await this.bot.api.sendMessage(chatId, text, { parse_mode: parseMode });
    } catch (err: any) {
      // If MarkdownV2/HTML parse fails, fall back to plain text
      if (err.error_code === 400 && err.description?.includes("can't parse")) {
        logger.warn(
          { err: err.description, parseMode },
          'parse_mode failed, retrying as plain text',
        );
        return await this.bot.api.sendMessage(chatId, text);
      }
      throw err;
    }
  }

  /** Edit an existing text message. Supports optional parse_mode with fallback. */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown',
  ): Promise<void> {
    if (!parseMode) {
      await this.bot.api.editMessageText(chatId, messageId, text);
      return;
    }

    try {
      await this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: parseMode });
    } catch (err: any) {
      if (err.error_code === 400 && err.description?.includes("can't parse")) {
        logger.warn(
          { err: err.description, parseMode },
          'editMessageText parse_mode failed, retrying as plain text',
        );
        await this.bot.api.editMessageText(chatId, messageId, text);
        return;
      }
      throw err;
    }
  }

  /**
   * Send a message draft (streaming indicator in DMs).
   * Only works in private chats (DM). Returns true on success.
   */
  async sendMessageDraft(chatId: string | number, draftId: number, text: string): Promise<boolean> {
    return await this.bot.api.sendMessageDraft(Number(chatId), draftId, text);
  }

  async sendPhoto(chatId: string | number, photo: Buffer, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(
      chatId,
      new InputFile(photo, 'image.png'),
      { caption },
    );
  }

  async sendChatAction(chatId: string | number, action: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, action as any);
  }

  async sendDocument(
    chatId: string | number,
    doc: Buffer,
    filename: string,
    caption?: string,
  ): Promise<void> {
    await this.bot.api.sendDocument(
      chatId,
      new InputFile(doc, filename),
      { caption },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeToken(token: string): string {
  if (!token) return '?';
  const parts = token.split(':');
  return parts.length === 2 ? `${parts[0]}:****` : token.slice(0, 8) + '...';
}
