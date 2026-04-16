import { randomUUID } from 'crypto';
import pino from 'pino';
import { IrisMessage, PluginContext } from './message';
import { ChannelAdapter } from './channels/types';
import { BackendAdapter } from './backends/types';
import { PluginPipeline } from './plugins/pipeline';
import { IrisConfig } from './config';

const logger = pino({ name: 'iris:engine' });

export type MessageHandler = (message: IrisMessage) => Promise<void>;

export class MessageEngine {
  private channelAdapters = new Map<string, ChannelAdapter>();
  private backendAdapters = new Map<string, BackendAdapter>();

  constructor(
    private pipeline: PluginPipeline,
    private config: IrisConfig,
  ) {}

  registerChannel(adapter: ChannelAdapter): void {
    this.channelAdapters.set(adapter.name, adapter);
  }

  registerBackend(adapter: BackendAdapter): void {
    this.backendAdapters.set(adapter.name, adapter);
  }

  /**
   * Deliver a reply to a user by sessionId without the original message context.
   * Used by the /v1/outbound endpoint for proactive messages from openclaw.
   * sessionId format: "<channel>:<channelUserId>"
   */
  async deliverReply(sessionId: string, text: string): Promise<void> {
    const colonIdx = sessionId.indexOf(':');
    if (colonIdx === -1) {
      logger.error({ sessionId }, 'deliverReply: invalid sessionId format');
      return;
    }
    const channelName = sessionId.slice(0, colonIdx);
    const channelUserId = sessionId.slice(colonIdx + 1);
    const channelAdapter = this.channelAdapters.get(channelName);
    if (!channelAdapter) {
      logger.error({ channelName, sessionId }, 'deliverReply: channel adapter not found');
      return;
    }
    if (!channelAdapter.replyToUser) {
      logger.error({ channelName }, 'deliverReply: channel adapter does not support replyToUser');
      return;
    }
    await channelAdapter.replyToUser(channelUserId, text);
  }

  /**
   * Main entry point — called by each channel adapter after parsing.
   * Orchestrates: session load → plugin pipeline → backend → reply.
   *
   * The backend's chat() blocks until the reply is ready (WebSocket backends
   * await the WS response internally; REST backends await the HTTP response).
   */
  handle = async (message: IrisMessage): Promise<void> => {
    try {
      await this._handle(message);
    } catch (e: any) {
      logger.error(
        {
          message,
          error: e.message,
        },
        '处理消息失败',
      );
    }
  };

  async _handle(message: IrisMessage): Promise<void> {
    // Normalize fields not yet set by the adapter (mirrors buildMessage defaults)
    if (!message.id) message.id = randomUUID();
    if (!message.sessionId) message.sessionId = `${message.channel}:${message.channelUserId}`;
    if (!message.timestamp) message.timestamp = Date.now();

    logger.info({ channel: message.channel, sessionId: message.sessionId }, 'incoming message');

    const ctx: PluginContext = {
      message,
      business: {},
    };
    await this.pipeline.run(ctx);

    // Route by channel instance name (adapter.name), fall back to default backend.
    // message.channel carries the adapter name set during registration.
    const backendName =
      this.config.backends.routes[message.channel] ?? this.config.backends.default;
    const backend = this.backendAdapters.get(backendName);
    if (!backend) {
      logger.error({ backendName }, 'backend not found');
      return;
    }

    const replyText = await backend.chat({
      message,
      context: ctx.business,
    });

    logger.info({ channel: message.channel, backendName }, 'got reply, sending back');

    const channelAdapter = this.channelAdapters.get(message.channel);
    if (!channelAdapter) {
      logger.error({ channel: message.channel }, 'channel adapter not found for reply');
      return;
    }
    await channelAdapter.reply(message, replyText);
  }
}
