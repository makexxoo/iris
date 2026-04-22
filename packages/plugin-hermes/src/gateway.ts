// packages/plugin-hermes/src/gateway.ts
import type { MessageContentPart } from '@agent-iris/protocol';
import type { SessionManager } from './session';
import { type HermesConfig, type IrisWsMessage, queryHermes } from './hermes';
import { type ExtractedFile, extractMedia } from './media';
import { logger } from './logger';

export type ReplyContent = MessageContentPart[];

function buildContentArray(text: string, files: ExtractedFile[]): ReplyContent {
  const parts: ReplyContent = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const f of files) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${f.mimeType};base64,${f.base64}`,
        detail: f.fileName,
      },
    });
  }
  // Always emit at least one text part so iris can safely read .text
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' });
  }
  return parts;
}

/**
 * Handle a single inbound iris message.
 * Enqueues work so messages for the same sessionId are processed serially.
 */
export function handleIrisMessage(params: {
  msg: IrisWsMessage;
  sessionManager: SessionManager;
  hermesConfig: HermesConfig;
  sendReply: (sessionId: string, content: ReplyContent) => void;
}): void {
  const { msg, sessionManager, hermesConfig, sendReply } = params;
  const { sessionId } = msg;

  sessionManager.enqueue(sessionId, async () => {
    const text = msg.content
      .filter((part): part is Extract<IrisWsMessage['content'][number], { type: 'text' }> => {
        return part.type === 'text';
      })
      .map((part) => part.text)
      .join('');
    if (!text) {
      logger.warn({ sessionId }, 'empty message text, skipping');
      return;
    }

    logger.info({ sessionId, channel: msg.channel, text: text }, 'handling iris message');

    try {
      const rawReply = await queryHermes(msg, hermesConfig);
      logger.info({ sessionId, channel: msg.channel, text: rawReply }, '智能体返回的文本');

      if (rawReply === null || rawReply === undefined) {
        logger.warn({ sessionId }, 'hermes returned empty result, skipping reply');
        return;
      }

      const { text: cleanText, files } = extractMedia(rawReply, (warning) =>
        logger.warn({ sessionId, warning }, 'media extraction warning'),
      );

      logger.info({ sessionId, files: files.length }, 'extracted media files');

      sendReply(sessionId, buildContentArray(cleanText, files));
    } catch (err) {
      logger.error({ err, sessionId }, 'hermes query error');
      sendReply(sessionId, [{ type: 'text', text: `Error: ${String(err)}` }]);
    }
  });
}
