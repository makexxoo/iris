import { SessionStateManager, WebSocketSessionBackend } from '@agent-iris/core';

export interface ClaudeCodeChannelConfig {
  /** Name used for routing in MessageEngine (default: 'claude-code') */
  name?: string;
  /** How long to wait for a reply before timing out, in ms (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** WS path to listen on (default: /ws/claude-code) */
  wsPath?: string;
}

/**
 * Backend adapter that connects to a claude-code-channel CLI via WebSocket.
 *
 * iris runs the WS server; the claude-code-channel CLI is the WS client.
 *
 * Protocol (identical to openclaw-channel):
 *   iris → CLI: { version: 2, type: 'message', context, payload: IrisMessage }
 *   CLI → iris: { version: 2, type: 'message|message_update', payload: IrisMessage }
 */
export class ClaudeCodeChannelBackend extends WebSocketSessionBackend {
  name = 'claude-code';

  constructor(
    private config: ClaudeCodeChannelConfig,
    sessionStates: SessionStateManager,
  ) {
    const timeoutMs = config.timeoutMs ?? 900_000;
    super(timeoutMs, sessionStates, config.wsPath ?? '/ws/claude-code');
    this.name = config.name ?? 'claude-code';
  }
}
