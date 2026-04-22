import type { IrisMessage } from '@agent-iris/protocol';

/** Iris channel config as stored in openclaw's config file (channels.iris section). */
export interface IrisChannelConfig {
  /** WebSocket URL of the iris gateway WS server (e.g. ws://iris.example.com:9528) */
  irisWsUrl: string;
  /** HTTP base URL of iris server for proactive outbound messages (optional, e.g. http://iris.example.com:9527) */
  irisUrl?: string;
  /** Optional secret for validating the connection (future use) */
  webhookSecret?: string;
  /** Allowed sender list (iris sessionIds or channel:userId pairs) */
  allowFrom?: string[];
  /** Whether this account is enabled */
  enabled?: boolean;
}

/** A resolved iris account, combining config with account metadata. */
export interface ResolvedIrisAccount {
  accountId: string;
  /** WebSocket URL for the main inbound/reply flow */
  irisWsUrl: string;
  /** HTTP base URL for proactive outbound messages (optional) */
  irisUrl?: string;
  webhookSecret?: string;
  enabled: boolean;
  config: {
    allowFrom: string[];
  };
}

/** Inbound payload from iris; directly reuses canonical protocol type. */
export type IrisInboundPayload = IrisMessage;
