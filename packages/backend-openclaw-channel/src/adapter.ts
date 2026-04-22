import { SessionStateManager, WebSocketSessionBackend } from '@agent-iris/core';

export interface OpenclawChannelConfig {
  /**名称，用于区分多个openclaw*/
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 60000) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/openclaw). Set explicitly when running multiple WS backends. */
  wsPath?: string;
}

/**
 * Backend adapter that connects to openclaw via a persistent WebSocket.
 *
 * iris runs the WS server; the openclaw iris-channel plugin is the WS client.
 * This means iris is reachable even behind NAT — openclaw initiates the connection.
 *
 * Protocol:
 *   iris → openclaw (WS): { version: 2, type: 'message', context, payload: IrisMessage }
 *   openclaw → iris (WS): { version: 2, type: 'message|message_update', payload: IrisMessage }
 *
 * chat() blocks until the reply arrives or the timeout fires.
 */
export class OpenclawChannelBackend extends WebSocketSessionBackend {
  name = 'openclaw';

  constructor(
    private config: OpenclawChannelConfig,
    sessionStates: SessionStateManager,
  ) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    super(timeoutMs, sessionStates, config.wsPath ?? "'/ws/openclaw'");
    this.name = config.name ?? 'openclaw';
  }
}
