import pino from 'pino';
import type { ChannelAdapter, IrisMessage, MessageHandler } from '@agent-iris/core';
import { extractTextFromContentParts } from '@agent-iris/core';
import { AppConnection, type FeishuAppConfig } from './app-connection.js';

type RegisterServer = Parameters<ChannelAdapter['register']>[0];

const logger = pino({ name: 'channel-feishu:adapter' });

export interface FeishuConfig {
  enabled?: boolean;
  /** Instance name for this channel (e.g. 'feishu-main'). Defaults to 'feishu'. */
  name?: string;
  apps: FeishuAppConfig[];
}

export class FeishuAdapter implements ChannelAdapter {
  readonly type: string = 'feishu';
  readonly name: string;
  private connections = new Map<string, AppConnection>();

  constructor(config: FeishuConfig, messageHandler: MessageHandler) {
    this.name = config.name ?? 'feishu';
    for (const appCfg of config.apps) {
      const conn = new AppConnection(this.type, appCfg, messageHandler, this.name);
      this.connections.set(appCfg.appId, conn);
    }
  }
  support(message: IrisMessage): boolean {
    return message.channelName == this.name;
  }

  /** Start all per-app WebSocket connections to Feishu/Lark event gateway */
  register(_server: RegisterServer): void {
    for (const conn of this.connections.values()) {
      conn.start();
    }
  }

  async reply(message: IrisMessage): Promise<void> {
    const raw = message.raw as Record<string, any>;
    const conn = this.connections.get(raw.app_id);
    if (!conn) {
      logger.error({ appId: raw.app_id }, 'feishu: no connection for appId');
      return;
    }
    await conn.sendToChat(raw.message.chat_id, extractTextFromContentParts(message.content));
  }
}
