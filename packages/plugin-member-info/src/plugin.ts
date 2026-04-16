import axios from 'axios';
import pino from 'pino';
import { PluginContext, Plugin } from '@agent-iris/core';

interface MemberInfoOptions {
  apiUrl: string;
}

interface MemberInfo {
  userId: string;
  name?: string;
  tier?: string;
  [key: string]: unknown;
}

const logger = pino({ name: 'iris:plugin:member-info' });

/**
 * Fetches member/user profile from an internal API and injects it into
 * ctx.business.member so that AI backends can personalise responses.
 *
 * Expected API contract:
 *   GET {apiUrl}/members/{channelUserId}?channel={channel}
 *   → 200 { userId, name, tier, ... }
 *   → 404 if not found (ignored gracefully)
 */
export class MemberInfoPlugin implements Plugin {
  readonly name = 'member-info';

  constructor(private options: MemberInfoOptions) {}

  async execute(ctx: PluginContext): Promise<void> {
    try {
      const res = await axios.get<MemberInfo>(
        `${this.options.apiUrl}/members/${ctx.message.channelUserId}`,
        { params: { channel: ctx.message.channel } },
      );
      ctx.business.member = res.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return;
      }
      logger.warn({ err }, 'member-info fetch failed, continuing without member data');
    }
  }
}
