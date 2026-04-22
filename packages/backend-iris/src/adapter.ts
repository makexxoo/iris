import { SessionStateManager, WebSocketSessionBackend } from '@agent-iris/core';

export interface IrisBackendConfig {
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/hermes) */
  wsPath?: string;
}

/**
 * Backend adapter that connects to the hermes-agent plugin (plugin-hermes) via WebSocket.
 *
 * iris runs the WS **server**; plugin-hermes is the WS **client**.
 * This mirrors the openclaw-channel and claude-code-channel pattern exactly.
 *
 * Protocol:
 *   iris → plugin (WS): { version: 2, type: 'message', context, payload: IrisMessage }
 *   plugin → iris (WS): { version: 2, type: 'message|message_update', payload: IrisMessage }
 */
export class IrisBackend extends WebSocketSessionBackend {
  name = 'iris';

  constructor(config: IrisBackendConfig, sessionStates: SessionStateManager) {
    const timeoutMs = config.timeoutMs ?? 300_000;
    super(timeoutMs, sessionStates, config.wsPath ?? '/ws/iris');
    this.name = config.name ?? 'iris';
  }
}
