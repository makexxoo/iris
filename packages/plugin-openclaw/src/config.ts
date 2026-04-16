import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type { IrisChannelConfig, ResolvedIrisAccount } from "./types.js";

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg as unknown as Record<string, unknown>)["channels"] as Record<string, unknown> ?? {};
}

function getIrisSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = getChannelSection(cfg);
  return (channels["iris"] as Record<string, unknown>) ?? {};
}

/**
 * List all configured iris account IDs from openclaw config.
 * Supports both single-account (channels.iris.irisUrl) and
 * multi-account (channels.iris.accounts.<id>) layouts.
 */
export function listIrisAccountIds(cfg: OpenClawConfig): string[] {
  const section = getIrisSection(cfg);
  const accounts = section["accounts"] as Record<string, unknown> | undefined;
  if (accounts && typeof accounts === "object") {
    return Object.keys(accounts);
  }
  if (section["irisWsUrl"]) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

/**
 * Resolve a single iris account config, merging defaults.
 */
export function resolveIrisAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedIrisAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = getIrisSection(cfg);
  const accounts = section["accounts"] as Record<string, unknown> | undefined;

  let raw: Record<string, unknown>;
  if (accounts && id !== DEFAULT_ACCOUNT_ID && accounts[id]) {
    raw = accounts[id] as Record<string, unknown>;
  } else {
    raw = section as Record<string, unknown>;
  }

  const irisConfig = raw as unknown as IrisChannelConfig;

  return {
    accountId: id,
    irisWsUrl: (irisConfig.irisWsUrl ?? "").replace(/\/$/, ""),
    irisUrl: irisConfig.irisUrl ? irisConfig.irisUrl.replace(/\/$/, "") : undefined,
    webhookSecret: irisConfig.webhookSecret,
    enabled: irisConfig.enabled !== false,
    config: {
      allowFrom: Array.isArray(irisConfig.allowFrom) ? irisConfig.allowFrom.map(String) : [],
    },
  };
}

export function resolveDefaultIrisAccountId(cfg: OpenClawConfig): string {
  const ids = listIrisAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
