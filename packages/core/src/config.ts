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
  /**
   * 该分组关联的微信 accountId 列表。
   * 启动时会从磁盘加载对应凭证；路由分发时按 accountId 归属到此分组。
   */
  accountIds?: string[];
}

/**
 * 顶级微信模块配置（全局单例）。
 * 控制 HTTP 路由注册、数据目录等基础设施，与具体 channel 分组无关。
 */
export interface WechatGlobalConfig {
  /** 是否启用微信模块（HTTP 路由 + 账号加载）。默认 true。 */
  enabled?: boolean;
  /**
   * 账号凭证持久化目录。
   * 默认 ~/.iris/wechat/accounts/
   */
  dataDir?: string;
}

export type ChannelConfig = FeishuChannelConfig | TelegramChannelConfig | WechatChannelConfig;

export interface BackendInstanceConfig {
  name: string;
  enabled?: boolean;
  wsPath?: string;
  timeoutMs?: number;
  /** Reserved for backend-specific extensions */
  options?: Record<string, unknown>;
}

export interface BackendGroupConfig {
  instances: BackendInstanceConfig[];
}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export interface IrisConfig {
  server: { port: number };

  /** 顶级微信模块全局配置 */
  wechat?: WechatGlobalConfig;

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

    /** WS-based openclaw-channel backend group */
    openclaw?: BackendGroupConfig;
    /** WS-based claude-code-channel backend group */
    'claude-code'?: BackendGroupConfig;
    /** WS-based hermes backend group */
    hermes?: BackendGroupConfig;

    /**
     * 自定义协议组
     */
    iris?: BackendGroupConfig;
  };

  plugins: Array<{ name: string; enabled?: boolean; options?: Record<string, unknown> }>;
}

export function loadConfig(configPath?: string): IrisConfig {
  const filePath = configPath ?? path.resolve(process.cwd(), 'config/default.yaml');
  console.log(`Loading config file: ${filePath}`);

  const envPath = path.resolve(process.cwd(), '.env');
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
