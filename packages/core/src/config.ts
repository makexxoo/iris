import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

// ---------------------------------------------------------------------------
// Channel config types (array form, each entry has type + name)
// ---------------------------------------------------------------------------

export interface FeishuChannelConfig {
  type: 'feishu';
  name: string;
  enabled?: boolean;
  apps: Array<{
    appId: string;
    appSecret: string;
    domain?: 'feishu' | 'lark';
    groupPolicy?: 'open' | 'allowlist' | 'disabled';
    streaming?: boolean;
    requireMention?: boolean;
  }>;
}

export interface TelegramChannelConfig {
  type: 'telegram';
  name: string;
  enabled?: boolean;
  botToken: string;
}

export interface WechatChannelConfig {
  type: 'wechat';
  name: string;
  enabled?: boolean;
  token: string;
  appId: string;
  appSecret: string;
  encodingAESKey: string;
}

export type ChannelConfig = FeishuChannelConfig | TelegramChannelConfig | WechatChannelConfig;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export interface IrisConfig {
  server: { port: number };

  /** All channel instances as an array. Each entry has a unique `name` and a `type`. */
  channels: ChannelConfig[];

  backends: {
    /** Fallback backend name when no route matches */
    default: string;
    /**
     * Route table: maps channel `name` → backend name.
     * e.g. { "feishu-main": "claude-code", "feishu-support": "openclaw" }
     */
    routes: Record<string, string>;
    hermes?: { baseUrl: string; token?: string };
    /** WS-based openclaw-channel backend */
    openclaw?: { timeoutMs?: number; path?: string; enabled?: boolean };
    /** WS-based claude-code-channel backend */
    'claude-code'?: { timeoutMs?: number; path?: string; enabled?: boolean };
  };

  plugins: Array<{ name: string; enabled?: boolean; options?: Record<string, unknown> }>;
}

export function loadConfig(configPath?: string): IrisConfig {
  const filePath = configPath ?? path.resolve(process.cwd(), 'config/default.yaml');

  // Load .env from the repo root (two levels above config/default.yaml).
  // override: false — bun or the shell may have already set vars; don't clobber them.
  const envPath = path.resolve(path.dirname(filePath), '../../.env');
  dotenv.config({ path: envPath, override: false });

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw) as Partial<IrisConfig>;
  // Provide safe defaults so missing YAML keys don't crash at runtime
  parsed.plugins ??= [];
  parsed.channels ??= [];
  parsed.backends ??= { default: '', routes: {} };
  parsed.backends.routes ??= {};
  return parsed as IrisConfig;
}
