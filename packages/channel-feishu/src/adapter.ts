import pino from 'pino';
import type { ChannelAdapter, IrisMessage, MessageHandler } from '@agent-iris/core';
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
  readonly name: string;
  private connections = new Map<string, AppConnection>();

  constructor(
    config: FeishuConfig,
    private messageHandler: MessageHandler,
  ) {
    this.name = config.name ?? 'feishu';
    for (const appCfg of config.apps) {
      const conn = new AppConnection(appCfg, messageHandler, this.name);
      this.connections.set(appCfg.appId, conn);
    }
  }

  /** Start all per-app WebSocket connections to Feishu/Lark event gateway */
  register(_server: RegisterServer): void {
    for (const conn of this.connections.values()) {
      conn.start();
    }
  }

  async reply(message: IrisMessage, text: string): Promise<void> {
    const raw = message.raw as Record<string, any>;
    const conn = this.connections.get(raw.app_id);
    if (!conn) {
      logger.error({ appId: raw.app_id }, 'feishu: no connection for appId');
      return;
    }
    await conn.sendToChat(raw.message.chat_id, text);
  }

  /**
   * Send a proactive message by channelUserId.
   * channelUserId format: "{appId}:{openId}"
   */
  async replyToUser(channelUserId: string, text: string): Promise<void> {
    const sepIdx = channelUserId.indexOf(':');
    if (sepIdx === -1) {
      logger.error(
        { channelUserId },
        'feishu: invalid channelUserId format (expected appId:openId)',
      );
      return;
    }
    const appId = channelUserId.slice(0, sepIdx);
    const openId = channelUserId.slice(sepIdx + 1);
    const conn = this.connections.get(appId);
    if (!conn) {
      logger.error({ appId }, 'feishu: no connection for appId');
      return;
    }
    await conn.sendToOpenId(openId, text);
  }
}
