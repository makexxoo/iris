import type { ChannelSetupWizard } from 'openclaw/plugin-sdk/setup';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';
import { resolveIrisAccount } from './config.js';

// ─── Config patch helper ─────────────────────────────────────────────────────

function patchIrisSection(cfg: OpenClawConfig, patch: Record<string, unknown>): OpenClawConfig {
  const raw = cfg as unknown as Record<string, unknown>;
  const channels = (raw['channels'] as Record<string, unknown>) ?? {};
  const iris = (channels['iris'] as Record<string, unknown>) ?? {};
  return {
    ...raw,
    channels: {
      ...channels,
      iris: { ...iris, ...patch },
    },
  } as unknown as OpenClawConfig;
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

export const irisSetupWizard: ChannelSetupWizard = {
  channel: 'iris',

  // Show URL inputs before the webhook secret credential
  stepOrder: 'text-first',

  status: {
    configuredLabel: 'Iris',
    unconfiguredLabel: 'Iris',
    resolveConfigured: ({ cfg, accountId }) => {
      const account = resolveIrisAccount(cfg, accountId);
      return Boolean(account.irisWsUrl?.trim());
    },
    resolveStatusLines: ({ cfg, accountId, configured }) => {
      const account = resolveIrisAccount(cfg, accountId);
      if (configured) {
        return [`Iris: connected to ${account.irisWsUrl}`];
      }
      return ['Iris: needs WebSocket URL'];
    },
  },

  introNote: {
    title: 'Iris Gateway',
    lines: [
      'Iris is a unified messaging gateway (WeChat, Feishu, Telegram, ...).',
      '',
      'Required: WebSocket URL of your iris server.',
      'Example: ws://iris.example.com:9527/ws/openclaw',
      'Optional: Webhook secret for connection authentication.',
    ],
  },

  // ── Text inputs (URLs) ──────────────────────────────────────────────────────

  textInputs: [
    {
      inputKey: 'url',
      message: 'Iris WebSocket URL',
      placeholder: 'ws://iris.example.com:9527/ws/openclaw',
      required: true,
      currentValue: ({ cfg, accountId }) => {
        const account = resolveIrisAccount(cfg, accountId);
        return account.irisWsUrl || undefined;
      },
      initialValue: ({ cfg, accountId }) => {
        const account = resolveIrisAccount(cfg, accountId);
        return account.irisWsUrl || undefined;
      },
      validate: ({ value }) => {
        if (!value?.trim()) return 'Required';
        if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
          return 'Must start with ws:// or wss://';
        }
        return undefined;
      },
      normalizeValue: ({ value }) => value.trim().replace(/\/$/, ''),
      applySet: ({ cfg, accountId: _, value }) => patchIrisSection(cfg, { irisWsUrl: value }),
    },
  ],

  // ── Credentials (webhook secret) ────────────────────────────────────────────

  credentials: [
    {
      inputKey: 'token',
      providerHint: 'iris',
      credentialLabel: 'Webhook Secret',
      preferredEnvVar: 'IRIS_WEBHOOK_SECRET',
      envPrompt: 'IRIS_WEBHOOK_SECRET detected. Use env var?',
      keepPrompt: 'Webhook secret already configured. Keep it?',
      inputPrompt: 'Enter iris webhook secret (optional — press Enter to skip)',
      inspect: ({ cfg, accountId }) => {
        const account = resolveIrisAccount(cfg, accountId);
        const envValue = process.env['IRIS_WEBHOOK_SECRET'];
        return {
          accountConfigured: Boolean(account.webhookSecret?.trim()),
          hasConfiguredValue: Boolean(account.webhookSecret?.trim()),
          resolvedValue: account.webhookSecret || undefined,
          envValue: envValue || undefined,
        };
      },
      // User chose to rely on env var — clear any stored secret
      applyUseEnv: ({ cfg, accountId: _ }) => patchIrisSection(cfg, { webhookSecret: undefined }),
      // User entered a value explicitly
      applySet: ({ cfg, accountId: _, resolvedValue }) =>
        patchIrisSection(cfg, { webhookSecret: resolvedValue || undefined }),
    },
  ],
};
