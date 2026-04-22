import { describe, expect, it } from 'bun:test';
import {
  BACKEND_PROTOCOL_VERSION,
  BackendProtocolErrorCode,
  parseBackendInboundEnvelope,
} from './protocol';

describe('backend protocol v2', () => {
  it('accepts valid inbound envelope', () => {
    const parsed = parseBackendInboundEnvelope(
      JSON.stringify({
        version: BACKEND_PROTOCOL_VERSION,
        type: 'message',
        timestamp: Date.now(),
        payload: {
          channel: 'feishu',
          channelUserId: 'u-1',
          content: { type: 'text', text: 'ok' },
        },
      }),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.envelope?.payload.channel).toBe('feishu');
  });

  it('rejects envelope without channel/channelUserId', () => {
    const parsed = parseBackendInboundEnvelope(
      JSON.stringify({
        version: BACKEND_PROTOCOL_VERSION,
        type: 'message',
        timestamp: Date.now(),
        payload: {
          content: { type: 'text', text: 'missing route' },
        },
      }),
    );
    expect(parsed.error?.code).toBe(BackendProtocolErrorCode.MISSING_CHANNEL);
  });
});
