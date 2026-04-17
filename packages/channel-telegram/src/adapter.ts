import { randomUUID } from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IrisMessage, ChannelAdapter, MessageEngine } from '@agent-iris/core';

interface TelegramConfig {
  botToken: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: TelegramBot;

  constructor(
    private config: TelegramConfig,
    private router: MessageEngine,
  ) {
    this.bot = new TelegramBot(config.botToken);
  }

  register(server: FastifyInstance): void {
    server.post('/webhook/telegram', async (req: FastifyRequest, reply: FastifyReply) => {
      const message = await this.parse(req, reply);
      if (message) {
        // Process asynchronously — Telegram expects a fast 200 response
        setImmediate(() => this.router.handle(message));
      }
      reply.status(200).send({ ok: true });
    });
  }

  async parse(req: FastifyRequest, _reply: FastifyReply): Promise<IrisMessage | null> {
    const update = req.body as TelegramBot.Update;

    const msg = update.message;
    if (!msg || !msg.text) return null;

    const userId = String(msg.from?.id ?? msg.chat.id);

    return {
      id: randomUUID(),
      channel: 'telegram',
      channelUserId: userId,
      sessionId: `telegram:${userId}`,
      content: { type: 'text', text: msg.text },
      timestamp: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
      raw: update,
    };
  }

  async reply(message: IrisMessage): Promise<void> {
    const rawUpdate = message.raw as TelegramBot.Update;
    const chatId = rawUpdate.message?.chat.id;
    if (chatId === undefined) return;
    await this.bot.sendMessage(chatId, message.content.text ?? '');
  }

  async replyToUser(channelUserId: string, text: string): Promise<void> {
    await this.bot.sendMessage(channelUserId, text);
  }

  /** Set the webhook URL after the server is up */
  async setWebhook(webhookUrl: string): Promise<void> {
    await this.bot.setWebHook(`${webhookUrl}/webhook/telegram`);
  }
}
