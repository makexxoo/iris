import pino from 'pino';
import type { ChannelAdapter, IrisMessage, MessageHandler } from '@agent-iris/core';
import { extractTextFromContentParts } from '@agent-iris/core';
import { BotConnection, type TelegramBotConfig } from './bot-connection.js';

type RegisterServer = Parameters<ChannelAdapter['register']>[0];

const logger = pino({ name: 'channel-telegram:adapter' });

// ---------------------------------------------------------------------------
// Markdown → Telegram MarkdownV2 converter (Hermes-style)
// ---------------------------------------------------------------------------

/** Characters that must be backslash-escaped in MarkdownV2. */
const MDV2_ESCAPE_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/** Matches a GFM table separator row (e.g. |---|:---:|---|). */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;

/**
 * Convert standard markdown to Telegram MarkdownV2 format.
 *
 * Steps (matching hermes-agent's format_message):
 * 0. Rewrite GFM pipe tables → bold-heading + bullet row groups
 * 1. Extract & protect fenced code blocks from escaping
 * 2. Extract & protect inline code from escaping
 * 3. Convert markdown → MarkdownV2 syntax (bold, italic, links)
 * 4. Escape all remaining special characters
 * 5. Restore protected code blocks
 */
function formatToMarkdownV2(content: string): string {
  if (!content) return content;

  const placeholders = new Map<string, string>();
  let counter = 0;
  const ph = (value: string): string => {
    const key = `\x00PH${counter++}\x00`;
    placeholders.set(key, value);
    return key;
  };

  let text = content;

  // Step 0: Rewrite GFM pipe tables into row groups
  text = wrapMarkdownTables(text);

  // Step 1: Protect fenced code blocks — escape \ and ` inside them
  text = text.replace(
    /(```(?:[^\n]*\n)?[\s\S]*?```)/g,
    (block) => {
      const nlIdx = block.indexOf('\n');
      const opening = nlIdx >= 0 ? block.slice(0, nlIdx + 1) : block;
      const bodyAndClose = nlIdx >= 0 ? block.slice(nlIdx + 1) : '';
      const closeLen = 3;
      const body = bodyAndClose.slice(0, -closeLen);
      const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      return ph(opening + escaped + '```');
    },
  );

  // Step 2: Protect inline code — escape \ inside them
  text = text.replace(
    /(`[^`]+`)/g,
    (span) => ph(span.replace(/\\/g, '\\\\')),
  );

  // Step 3: Convert markdown links [text](url) → MarkdownV2
  // In MarkdownV2 the display text must have ) and \ escaped
  text = text.replace(
    /\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, display: string, url: string) => {
      const escaped = display.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
      return `[${escaped}](${url})`;
    },
  );

  // Step 4: Convert **bold** → *bold* (MarkdownV2 single-asterisk bold)
  text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Step 5: Convert *italic* → _italic_ (MarkdownV2 underscore italic)
  // Only outside words to avoid breaking snake_case
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '_$1_');

  // Step 6: Convert ~~strikethrough~~ → ~strikethrough~
  text = text.replace(/~~([^~]+)~~/g, '~$1~');

  // Step 7: Escape all remaining MarkdownV2 special characters
  text = text.replace(MDV2_ESCAPE_RE, '\\$1');

  // Step 8: Restore placeholders (protected code blocks & inline code)
  for (const [key, value] of placeholders) {
    text = text.replace(key, value);
  }

  return text;
}

// ---------------------------------------------------------------------------
// GFM table → ASCII table inside a code block
// ---------------------------------------------------------------------------
// Telegram MarkdownV2 has no table syntax, but fenced code blocks (```)
// use monospace font which preserves column alignment. We render tables as
// compact ASCII art inside a code block so the tabular structure is kept.

/** Max column width before truncation (keep mobile screens in mind). */
const MAX_COL_WIDTH = 18;

function wrapMarkdownTables(text: string): string {
  if (!text.includes('|') || !text.includes('-')) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip content inside fenced code blocks
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    // Detect table: header row with '|' followed by a separator row
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1])
    ) {
      const tableBlock: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        tableBlock.push(lines[j]);
        j++;
      }
      out.push(renderTableAsAscii(tableBlock));
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return out.join('\n');
}

function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);
  return stripped.split('|').map((c) => c.trim());
}

function renderTableAsAscii(tableBlock: string[]): string {
  if (tableBlock.length < 3) return tableBlock.join('\n');

  const headers = splitTableRow(tableBlock[0]);
  if (headers.length < 2) return tableBlock.join('\n');

  const dataRows = tableBlock.slice(2).map(splitTableRow);
  const allRows = [headers, ...dataRows];

  // Calculate column widths, capped at MAX_COL_WIDTH
  const colWidths = headers.map((_, ci) => {
    const max = Math.max(...allRows.map((row) => truncate(row[ci] ?? '', MAX_COL_WIDTH).length));
    return Math.max(max, 3); // minimum 3 chars wide
  });

  const fmt = (row: string[]) =>
    '│ ' +
    row.map((cell, ci) => truncate(cell, MAX_COL_WIDTH).padEnd(colWidths[ci])).join(' │ ') +
    ' │';

  const sep =
    '├' + colWidths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';

  const top =
    '┌' + colWidths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';

  const bottom =
    '└' + colWidths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const ascii = [
    top,
    fmt(headers),
    sep,
    ...dataRows.map(fmt),
    bottom,
  ].join('\n');

  return '\n```\n' + ascii + '\n```\n';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Format resolution from IrisMessage.extra
// ---------------------------------------------------------------------------

function resolveFormat(
  extra?: Record<string, unknown>,
): { mode: 'MarkdownV2' | 'HTML' | undefined; convertMd: boolean } {
  if (!extra) return { mode: undefined, convertMd: false };

  const hint = (
    extra.format ??
    extra.contentType ??
    extra.parseMode ??
    extra.parse_mode ??
    ''
  ).toString().toLowerCase();

  if (hint === 'markdown' || hint === 'md' || hint === 'markdownv2') {
    return { mode: 'MarkdownV2', convertMd: true };
  }
  if (hint === 'html') {
    return { mode: 'HTML', convertMd: false };
  }
  return { mode: undefined, convertMd: false };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

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

    const finalText = extractTextFromContentParts(message.content ?? []);
    let text = finalText || buffered;
    if (text) {
      const { mode, convertMd } = resolveFormat(message.extra);
      if (convertMd) {
        text = formatToMarkdownV2(text);
      }
      await this.connection.sendText(chatId, text, mode);
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
