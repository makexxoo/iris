import { randomUUID } from 'crypto';
import axios, { AxiosError } from 'axios';
import pino from 'pino';
import type { IrisMessage, MessageHandler } from '@agent-iris/core';
import { type SendFileParams, uploadAndBuildItem } from './ilink-media.js';

const logger = pino({ name: 'channel-wechat:account' });

// ---------------------------------------------------------------------------
// iLink Bot API constants
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.2.0';
// 2<<16 | 2<<8 | 0  = 131584
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 10 * 60 * 1000; // 10 minutes
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// iLink message field constants
const ITEM_TEXT = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WechatAccountConfig {
  accountId: string;
  token: string;
  groupName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildHeaders(token: string | null, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeId(value: string | undefined | null, keep = 8): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '?';
  return raw.length <= keep ? raw : raw.slice(0, keep);
}

function extractText(itemList: Array<Record<string, unknown>>): string {
  for (const item of itemList) {
    if (item['type'] === ITEM_TEXT) {
      const textItem = (item['text_item'] as Record<string, unknown> | undefined) ?? {};
      return String(textItem['text'] ?? '');
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// AccountConnection
// ---------------------------------------------------------------------------

export class AccountConnection {
  private readonly accountId: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly onMessage: MessageHandler;

  /** context_token cache keyed by fromUserId */
  private contextTokens = new Map<string, string>();
  /** dedup cache: messageId -> timestamp */
  private seenMessages = new Map<string, number>();
  /** get_updates_buf cursor */
  private syncBuf = '';
  /** long-poll timeout (server may suggest a different value) */
  private pollTimeoutMs = LONG_POLL_TIMEOUT_MS;

  private running = false;
  private pollAbortController: AbortController | null = null;

  constructor(
    private readonly config: WechatAccountConfig,
    onMessage: MessageHandler,
  ) {
    this.accountId = config.accountId;
    this.token = config.token;
    this.baseUrl = ILINK_BASE_URL;
    this.onMessage = onMessage;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this._pollLoop().catch((err) => {
      logger.error({ accountId: safeId(this.accountId), err }, 'poll loop exited unexpectedly');
    });
  }

  stop(): void {
    this.running = false;
    this.pollAbortController?.abort();
  }

  // -------------------------------------------------------------------------
  // Public send API
  // -------------------------------------------------------------------------

  async sendText(toUserId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(toUserId) ?? null;
    const clientId = `iris-wechat-${randomUUID().replace(/-/g, '')}`;
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    };
    if (contextToken) {
      message['context_token'] = contextToken;
    }

    const payload = {
      msg: message,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const body = JSON.stringify(payload);
    const url = `${this.baseUrl}/${EP_SEND_MESSAGE}`;

    await axios.post(url, body, {
      headers: buildHeaders(this.token, body),
      timeout: API_TIMEOUT_MS,
    });
  }

  async sendFile(
    toUserId: string,
    fileBytes: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<void> {
    const contextToken = this.contextTokens.get(toUserId) ?? null;
    const clientId = `iris-wechat-${randomUUID().replace(/-/g, '')}`;
    const params: SendFileParams = {
      baseUrl: this.baseUrl,
      token: this.token,
      toUserId,
      fileBytes,
      fileName,
      mimeType,
      contextToken,
      clientId,
      buildHeaders,
    };
    const item = await uploadAndBuildItem(params);

    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [item],
    };
    if (contextToken) {
      message['context_token'] = contextToken;
    }

    const payload = { msg: message, base_info: { channel_version: CHANNEL_VERSION } };
    const body = JSON.stringify(payload);
    const url = `${this.baseUrl}/${EP_SEND_MESSAGE}`;

    await axios.post(url, body, {
      headers: buildHeaders(this.token, body),
      timeout: API_TIMEOUT_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Long-poll loop
  // -------------------------------------------------------------------------

  private async _pollLoop(): Promise<void> {
    let consecutiveFailures = 0;

    logger.info({ accountId: safeId(this.accountId), baseUrl: this.baseUrl }, 'starting poll loop');

    while (this.running) {
      try {
        const response = await this._getUpdates();

        // Server may hint at a different timeout
        const suggested = response['longpolling_timeout_ms'];
        if (typeof suggested === 'number' && suggested > 0) {
          this.pollTimeoutMs = suggested;
        }

        const ret = response['ret'] ?? 0;
        const errcode = response['errcode'] ?? 0;

        if (ret !== 0 || errcode !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
            logger.error(
              { accountId: safeId(this.accountId) },
              'session expired; pausing for 10 minutes',
            );
            await sleep(SESSION_EXPIRED_PAUSE_MS);
            consecutiveFailures = 0;
            continue;
          }
          consecutiveFailures++;
          logger.warn(
            {
              accountId: safeId(this.accountId),
              ret,
              errcode,
              errmsg: response['errmsg'],
              consecutiveFailures,
            },
            'getupdates returned error',
          );
          const delay =
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          await sleep(delay);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
          }
          continue;
        }

        consecutiveFailures = 0;

        const newBuf = String(response['get_updates_buf'] ?? '');
        if (newBuf) {
          this.syncBuf = newBuf;
        }

        this._cleanDedup();

        const msgs = (response['msgs'] as Array<Record<string, unknown>> | null | undefined) ?? [];
        for (const msg of msgs) {
          this._processMessage(msg).catch((err) => {
            logger.error({ accountId: safeId(this.accountId), err }, 'error processing message');
          });
        }
      } catch (err) {
        // Axios timeout is treated as an empty poll (not a real failure)
        if (this._isTimeout(err)) {
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures++;
        logger.error(
          { accountId: safeId(this.accountId), consecutiveFailures, err },
          'poll loop error',
        );
        const delay =
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        await sleep(delay);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
        }
      }
    }

    logger.info({ accountId: safeId(this.accountId) }, 'poll loop stopped');
  }

  private async _getUpdates(): Promise<Record<string, unknown>> {
    const payload = {
      get_updates_buf: this.syncBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const body = JSON.stringify(payload);
    const url = `${this.baseUrl}/${EP_GET_UPDATES}`;

    try {
      const res = await axios.post<Record<string, unknown>>(url, body, {
        headers: buildHeaders(this.token, body),
        // Add a small buffer on top of the server long-poll timeout
        timeout: this.pollTimeoutMs + 5_000,
      });
      return res.data;
    } catch (err) {
      if (this._isTimeout(err)) {
        return { ret: 0, msgs: [], get_updates_buf: this.syncBuf };
      }
      throw err;
    }
  }

  private _isTimeout(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      const e = err as AxiosError;
      return e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Message processing
  // -------------------------------------------------------------------------

  private async _processMessage(message: Record<string, unknown>): Promise<void> {
    const senderId = String(message['from_user_id'] ?? '').trim();
    if (!senderId) return;
    // Ignore messages sent by the bot itself
    if (senderId === this.accountId) return;

    const messageId = String(message['message_id'] ?? '').trim();
    if (messageId && this._isDuplicate(messageId)) return;
    if (messageId) this._markSeen(messageId);

    const contextToken = String(message['context_token'] ?? '').trim();
    if (contextToken) {
      this.contextTokens.set(senderId, contextToken);
    }

    const itemList =
      (message['item_list'] as Array<Record<string, unknown>> | null | undefined) ?? [];
    const text = extractText(itemList);
    if (!text) return;

    const irisMessage: IrisMessage = {
      id: randomUUID(),
      type: 'message',
      channel: this.config.groupName,
      // channelUserId format: "{accountId}:{fromUserId}" for routing in replyToUser
      channelUserId: `${this.accountId}:${senderId}`,
      sessionId: `wechat:${this.config.groupName}:${this.accountId}:${senderId}`,
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
      raw: {
        accountId: this.accountId,
        toUserId: senderId,
        message,
      },
    };

    logger.info({ accountId: safeId(this.accountId), from: safeId(senderId) }, 'inbound message');

    try {
      await this.sendText(senderId, 'OK');
    } catch (e) {
      /* empty */
    }
    this.onMessage(irisMessage);
  }

  // -------------------------------------------------------------------------
  // Dedup helpers
  // -------------------------------------------------------------------------

  private _isDuplicate(messageId: string): boolean {
    const ts = this.seenMessages.get(messageId);
    if (ts === undefined) return false;
    return Date.now() - ts < MESSAGE_DEDUP_TTL_MS;
  }

  private _markSeen(messageId: string): void {
    this.seenMessages.set(messageId, Date.now());
  }

  private _cleanDedup(): void {
    const cutoff = Date.now() - MESSAGE_DEDUP_TTL_MS;
    for (const [id, ts] of this.seenMessages) {
      if (ts < cutoff) this.seenMessages.delete(id);
    }
  }
}
