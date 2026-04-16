import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from 'openclaw/plugin-sdk/core';
import { createChatChannelPlugin, type ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { chunkTextForOutbound } from 'openclaw/plugin-sdk/text-chunking';
import { createStaticReplyToModeResolver } from 'openclaw/plugin-sdk/conversation-runtime';
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from 'openclaw/plugin-sdk/channel-send-result';
import { sendPayloadWithChunkedTextAndMedia } from 'openclaw/plugin-sdk/reply-payload';
import { createComputedAccountStatusAdapter } from 'openclaw/plugin-sdk/status-helpers';
import { z } from 'zod';
import { listIrisAccountIds, resolveIrisAccount, resolveDefaultIrisAccountId } from './config.js';
import { startIrisGatewayAccount } from './gateway.js';
import { irisSetupWizard } from './setup.js';
import type { ResolvedIrisAccount } from './types.js';

// ─── Config schema ────────────────────────────────────────────────────────────

const IrisConfigSchema = z.object({
  /** WebSocket URL for the main inbound/reply flow (e.g. ws://iris-host:9528) */
  irisWsUrl: z.string().optional(),
  /** HTTP base URL used for proactive outbound messages (e.g. https://iris-host:9527). Optional. */
  irisUrl: z.url().optional(),
  webhookSecret: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

// ─── Channel meta ─────────────────────────────────────────────────────────────

const meta = {
  id: 'iris',
  label: 'Iris Gateway',
  selectionLabel: 'Iris (Messaging Gateway)',
  docsPath: '/channels/iris',
  docsLabel: 'iris',
  blurb: 'Unified messaging gateway supporting WeChat, Feishu, Telegram and more.',
  aliases: ['ir'],
  order: 90,
};

// ─── Outbound: proactive messages from openclaw → iris → user channel ─────────
// Requires irisUrl (HTTP) to be configured. Used for /send commands in openclaw.

const irisRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: 'iris',
  sendText: async ({ to, text, accountId, cfg }) => {
    const account = resolveIrisAccount(cfg, accountId);
    if (!account.irisUrl) {
      throw new Error('iris: irisUrl not configured — cannot send proactive outbound message');
    }
    const url = `${account.irisUrl}/v1/outbound`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: to, text }),
    });
    if (!res.ok) {
      throw new Error(`iris outbound failed: ${res.status}`);
    }
    return { ok: true };
  },
});

// ─── Setup adapter ────────────────────────────────────────────────────────────

const irisSetupAdapter = {
  applyAccountConfig: (params: {
    cfg: unknown;
    accountId: string;
    input: Record<string, unknown>;
  }) => {
    const cfg = params.cfg as Record<string, unknown>;
    const channels = (cfg['channels'] as Record<string, unknown>) ?? {};
    const iris = (channels['iris'] as Record<string, unknown>) ?? {};
    return {
      ...cfg,
      channels: {
        ...channels,
        iris: {
          ...iris,
          // "url" = ChannelSetupInput.url → irisWsUrl
          ...(params.input['url'] ? { irisWsUrl: params.input['url'] } : {}),
          // "token" = ChannelSetupInput.token → webhookSecret (optional)
          ...(params.input['token'] ? { webhookSecret: params.input['token'] } : {}),
        },
      },
    };
  },
};

// ─── Plugin export ────────────────────────────────────────────────────────────

export const irisPlugin: ChannelPlugin<ResolvedIrisAccount> = createChatChannelPlugin({
  base: {
    id: 'iris',
    meta,
    setup: irisSetupAdapter,
    setupWizard: irisSetupWizard,
    capabilities: {
      chatTypes: ['direct'],
      media: false,
      reactions: false,
      threads: false,
      polls: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ['channels.iris'] },
    configSchema: buildChannelConfigSchema(IrisConfigSchema),
    config: {
      listAccountIds: listIrisAccountIds,
      resolveAccount: (cfg, accountId) => resolveIrisAccount(cfg, accountId),
      defaultAccountId: resolveDefaultIrisAccountId,
      isConfigured: (account: ResolvedIrisAccount) => Boolean(account.irisWsUrl?.trim()),
      describeAccount: (account: ResolvedIrisAccount) => ({
        accountId: account.accountId,
        name: `Iris (${account.irisWsUrl || 'unconfigured'})`,
        enabled: account.enabled,
        configured: Boolean(account.irisWsUrl?.trim()),
        baseUrl: account.irisUrl || undefined,
      }),
    },
    status: createComputedAccountStatusAdapter<ResolvedIrisAccount>({
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        name: 'Iris',
        enabled: false,
        configured: false,
      },
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: `Iris (${account.irisWsUrl || 'unconfigured'})`,
        enabled: account.enabled,
        configured: Boolean(account.irisWsUrl?.trim()),
        baseUrl: account.irisUrl || undefined,
      }),
    }),
    gateway: {
      startAccount: startIrisGatewayAccount,
    },
  },
  threading: {
    resolveReplyToMode: createStaticReplyToModeResolver('off'),
  },
  outbound: {
    deliveryMode: 'direct',
    chunker: chunkTextForOutbound,
    chunkerMode: 'text',
    textChunkLimit: 4000,
    sendPayload: async (ctx) =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: 4000,
        chunker: chunkTextForOutbound,
        sendText: (nextCtx) => irisRawSendResultAdapter.sendText!(nextCtx),
        sendMedia: (nextCtx) => irisRawSendResultAdapter.sendText!(nextCtx),
        emptyResult: createEmptyChannelResult('iris'),
      }),
    ...irisRawSendResultAdapter,
  },
});
