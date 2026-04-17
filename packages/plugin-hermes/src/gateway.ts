import type { SessionManager } from './session';
import { queryHermes, type HermesConfig, type IrisWsMessage } from './hermes';
import { logger } from './logger';

/**
 * Handle a single inbound iris message.
 * Enqueues work so messages for the same sessionId are processed serially.
 */
export function handleIrisMessage(params: {
  msg: IrisWsMessage;
  sessionManager: SessionManager;
  hermesConfig: HermesConfig;
  sendReply: (sessionId: string, text: string) => void;
}): void {
  const { msg, sessionManager, hermesConfig, sendReply } = params;
  const { sessionId } = msg;

  sessionManager.enqueue(sessionId, async () => {
    const text = msg.content.text ?? '';
    if (!text) {
      logger.warn({ sessionId }, 'empty message text, skipping');
      return;
    }

    logger.info({ sessionId, channel: msg.channel, text: text.slice(0, 80) }, 'handling iris message');

    try {
      const reply = await queryHermes(msg, hermesConfig);

      if (!reply) {
        logger.warn({ sessionId }, 'hermes returned empty result, skipping reply');
        return;
      }

      sendReply(sessionId, reply);
    } catch (err) {
      logger.error({ err, sessionId }, 'hermes query error');
      sendReply(sessionId, `Error: ${String(err)}`);
    }
  });
}
