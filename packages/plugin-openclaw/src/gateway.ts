import WebSocket from 'ws';
import { type IrisMessage } from '@agent-iris/protocol';
import type { ChannelGatewayContext } from 'openclaw/plugin-sdk/channel-contract';
import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import type { ResolvedIrisAccount, IrisInboundPayload } from './types.js';

/** WS message sent from iris to openclaw */
type IrisWsInbound = IrisMessage;

function readInboundTextFromContentParts(content: IrisWsInbound['content']): string {
  return content
    .filter((part): part is Extract<IrisWsInbound['content'][number], { type: 'text' }> => {
      return part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

/**
 * Extract plain text from a buffered reply payload.
 * openclaw's ReplyPayload may contain blocks; we join all text blocks.
 */
function extractTextFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;

  if (Array.isArray(p['blocks'])) {
    return (p['blocks'] as Array<Record<string, unknown>>)
      .filter((b) => b['type'] === 'text' || b['kind'] === 'text')
      .map((b) => String(b['text'] ?? b['content'] ?? ''))
      .join('\n')
      .trim();
  }

  if (typeof p['text'] === 'string') return p['text'];
  return '';
}

/**
 * Process a single inbound iris message through openclaw's AI pipeline.
 * When the reply is ready, `sendReply` is called to push it back over WS.
 */
async function dispatchIrisMessage(params: {
  ctx: ChannelGatewayContext<ResolvedIrisAccount>;
  payload: IrisInboundPayload;
  sendReply: (sessionId: string, text: string) => void;
}): Promise<void> {
  const { ctx, payload, sendReply } = params;
  const { account, cfg, log } = ctx;
  // channelRuntime is typed as ChannelRuntimeSurface (minimal surface) but at
  // runtime carries the full plugin runtime. Cast to any to access reply/session/routing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = ctx.channelRuntime as any;

  if (!core) {
    log?.warn?.('iris: channelRuntime not available — skipping AI dispatch');
    return;
  }

  const rawBody = payload.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const sessionId = payload.sessionId;
  const channelUserId = payload.channelUserId;

  const channel = payload.channel;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel,
    accountId: account.accountId,
    peer: { kind: 'direct', id: channelUserId },
    runtime: core,
  });

  const fromLabel = `${channel}:${channelUserId}`;
  const { storePath, body } = buildEnvelope({
    channel,
    from: fromLabel,
    timestamp: payload.timestamp,
    body: rawBody,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `${channel}:${channelUserId}`,
    To: `${channel}:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: 'direct',
    ConversationLabel: fromLabel,
    SenderId: channelUserId,
    Provider: channel,
    Surface: channel,
    MessageSid: payload.id,
  });

  await core.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      log?.warn?.(`iris: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected: _, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel,
    accountId: account.accountId,
  });

  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (replyPayload: unknown) => {
        const text = extractTextFromPayload(replyPayload);
        if (!text) {
          log?.warn?.(`iris: empty reply for session ${sessionId}, skipping delivery`);
          return;
        }
        sendReply(sessionId, text);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: unknown, info: any) => {
        log?.warn?.(`iris: [${account.accountId}] ${info.kind} reply error: ${String(err)}`);
      },
    },
  });
}

/**
 * Connect to iris's WebSocket server and maintain the connection.
 * Reconnects automatically with a 5-second backoff after disconnect.
 */
function connectWithReconnect(params: {
  ctx: ChannelGatewayContext<ResolvedIrisAccount>;
  abortSignal: AbortSignal;
}): void {
  const { ctx, abortSignal } = params;
  const { account, log } = ctx;

  if (abortSignal.aborted) return;

  const ws = new WebSocket(account.irisWsUrl);

  ws.on('open', () => {
    log?.info?.(`[${account.accountId}] iris WS connected to ${account.irisWsUrl}`);
  });

  ws.on('message', (raw) => {
    if (abortSignal.aborted) return;

    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;
    const inbound = msg as Partial<IrisWsInbound>;
    if (inbound.type !== 'message') return;
    if (!Array.isArray(inbound.content)) return;
    const inboundText = readInboundTextFromContentParts(inbound.content);
    if (!inboundText) return; // skip non-text for now

    const payload: IrisInboundPayload = {
      id: String(inbound.id ?? ''),
      type: inbound.type ?? 'message',
      channel: String(inbound.channel ?? ''),
      channelUserId: String(inbound.channelUserId ?? ''),
      sessionId: String(inbound.sessionId ?? ''),
      content: [{ type: 'text', text: inboundText }],
      timestamp: typeof inbound.timestamp === 'number' ? inbound.timestamp : Date.now(),
      raw: inbound.raw ?? { source: 'plugin-openclaw-inbound' },
      context: inbound.context,
    };

    dispatchIrisMessage({
      ctx,
      payload,
      sendReply: (sessionId, text) => {
        if (ws.readyState === WebSocket.OPEN) {
          const now = Date.now();
          ws.send(
            JSON.stringify(<IrisMessage>{
              id: `reply-${now}`,
              type: 'message',
              sessionId,
              channel: String(inbound.channel ?? ''),
              channelUserId: String(inbound.channelUserId ?? ''),
              content: [{ type: 'text', text }],
              timestamp: now,
              raw: { source: 'plugin-openclaw' },
            }),
          );
        }
      },
    }).catch((err) => {
      log?.warn?.(`[${account.accountId}] iris: dispatch error: ${String(err)}`);
    });
  });

  ws.on('close', () => {
    log?.info?.(`[${account.accountId}] iris WS disconnected`);
    if (!abortSignal.aborted) {
      setTimeout(() => connectWithReconnect({ ctx, abortSignal }), 5_000);
    }
  });

  ws.on('error', (err) => {
    // 'close' will fire after this — reconnect is handled there
    log?.warn?.(`[${account.accountId}] iris WS error: ${String(err)}`);
  });

  abortSignal.addEventListener('abort', () => ws.close(), { once: true });
}

/**
 * Start the iris channel gateway account.
 * Connects to iris's WebSocket server and keeps the connection alive
 * until openclaw signals the account should stop.
 */
export async function startIrisGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedIrisAccount>,
): Promise<void> {
  const { account, log, abortSignal } = ctx;

  log?.info?.(`[${account.accountId}] iris channel starting, wsUrl=${account.irisWsUrl}`);

  if (!account.irisWsUrl) {
    log?.warn?.(`[${account.accountId}] iris: irisWsUrl not configured, channel inactive`);
    return;
  }

  connectWithReconnect({ ctx, abortSignal });

  // Hold until openclaw signals the account should stop
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener('abort', () => resolve(), { once: true });
  });

  log?.info?.(`[${account.accountId}] iris channel stopped`);
}
