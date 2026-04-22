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
  private channelAdapters: Array<ChannelAdapter> = [];
  private backendAdapters = new Map<string, BackendAdapter>();

  constructor(
    private pipeline: PluginPipeline,
    private config: IrisConfig,
  ) {}

  registerChannel(adapter: ChannelAdapter): void {
    this.channelAdapters.push(adapter);
  }

  registerBackend(adapter: BackendAdapter): void {
    this.backendAdapters.set(adapter.name, adapter);
  }

  /**
   * Main entry point — called by each channel adapter after parsing.
   * Orchestrates: session load → plugin pipeline → backend dispatch.
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

    const channelAdapter = this.channelAdapters.find((item) => {
      return item.support(message);
    });

    if (!channelAdapter) {
      logger.error({ channel: message.channel }, 'channel adapter not found for reply');
      return;
    }

    // Route by channel instance name (adapter.name), fall back to default backend.
    // message.channel carries the adapter name set during registration.
    const backendName =
      this.config.backends.routes[message.channel] ?? this.config.backends.default;
    const backend = this.backendAdapters.get(backendName);
    if (!backend) {
      logger.error({ backendName }, 'backend not found');
      message.content = [
        {
          type: 'text',
          text: `backend not found: ${backendName}. 请联系管理员为您配置智能体`,
        },
      ];
      await channelAdapter.reply(message);
      return;
    }

    try {
      message.context = ctx.business;
      await backend.chat({
        message,
        channelAdapter,
      });
      logger.info(
        { channel: message.channel, backendName },
        'backend accepted message in async mode',
      );
    } catch (e) {
      logger.info({ channel: message.channel, backendName, error: e }, '智能体处理失败');
      message.content = [{ type: 'text', text: `智能体调用失败: ${e}` }];
      await channelAdapter.reply(message);
    }
  }
}
