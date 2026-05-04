import pino from 'pino';
import type { ChannelAdapter, IrisMessage, MessageHandler } from '@agent-iris/core';
import { extractTextFromContentParts } from '@agent-iris/core';
import {
  AccountConnection,
  type PolicyMode,
  type WechatAccountConfig,
} from './account-connection.js';
import {
  defaultDataDir,
  fetchQrCode,
  listSavedAccounts,
  pollQrStatusOnce,
  type QrCodeInfo,
  saveCredential,
  type WechatCredential,
} from './qr-login.js';

type RegisterServer = Parameters<ChannelAdapter['register']>[0];

const logger = pino({ name: 'channel-wechat:adapter' });

/**
 * 顶级微信模块配置，对应 config.yaml 中的 `wechat:` 块。
 * 控制 HTTP 路由注册、账号凭证目录等基础设施。
 */
export interface WechatConfig {
  enabled?: boolean;
  /**
   * 账号凭证持久化目录。
   * Defaults to ~/.iris/wechat/accounts/
   */
  dataDir?: string;
  /** DM policy: 'open' (default), 'disabled', or 'allowlist' */
  dmPolicy?: PolicyMode;
  /** Group policy: 'disabled' (default), 'open', or 'allowlist' */
  groupPolicy?: PolicyMode;
  /** Allowed user IDs when dmPolicy is 'allowlist' */
  allowFrom?: string[];
  /** Allowed group/room IDs when groupPolicy is 'allowlist' */
  groupAllowFrom?: string[];
}

/**
 * channels 数组中一个 wechat 分组条目，对应 `channels[].type = 'wechat'`。
 * 仅用于路由分发分组，不承载基础设施配置。
 */
export interface WechatChannelGroup {
  /** 分组唯一名称，对应 backends.routes 中的 key */
  name: string;
  enabled?: boolean;
  /**
   * 该分组关联的 accountId 列表。
   * 启动时从磁盘加载对应凭证并建立连接；消息路由时按 accountId 归属此分组。
   */
  accountIds?: string[];
}

// ---------------------------------------------------------------------------
// In-flight QR session state
// ---------------------------------------------------------------------------

interface QrSession {
  qrcode: string;
  imageUrl: string;
  baseUrl: string;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  credential?: WechatCredential;
  error?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// WechatAdapter
// ---------------------------------------------------------------------------

export class WechatAdapter implements ChannelAdapter {
  readonly type = 'wechat';
  readonly name = 'wechat';
  private static readonly defaultGroupName = 'wechat-default';

  private connections = new Map<string, AccountConnection>();
  private groupNames: Set<string> = new Set();
  private readonly messageHandler: MessageHandler;
  readonly dataDir: string;
  private readonly dmPolicy: PolicyMode;
  private readonly groupPolicy: PolicyMode;
  private readonly allowFrom: string[];
  private readonly groupAllowFrom: string[];

  /** Active QR sessions keyed by a short session ID */
  private qrSessions = new Map<string, QrSession>();

  /**
   * @param config 顶级 wechat 模块配置（对应 config.yaml `wechat:` 块）
   * @param messageHandler
   */
  constructor(config: WechatConfig, messageHandler: MessageHandler) {
    this.messageHandler = messageHandler;
    this.dataDir = config.dataDir ?? defaultDataDir();
    this.dmPolicy = config.dmPolicy ?? 'open';
    this.groupPolicy = config.groupPolicy ?? 'disabled';
    this.allowFrom = config.allowFrom ?? [];
    this.groupAllowFrom = config.groupAllowFrom ?? [];
  }

  support(message: IrisMessage): boolean {
    if (message.channelType !== this.type) return false;
    return this.groupNames.has(message.channelName);
  }

  // -------------------------------------------------------------------------
  // ChannelAdapter interface
  // -------------------------------------------------------------------------

  /**
   * 注册 HTTP 路由（QR 登录等），由 server/index.ts 在启动时调用一次。
   * 不负责启动账号连接，账号连接由 loadChannelGroup 负责。
   */
  register(server: RegisterServer): void {
    this._registerRoutes(server);
    logger.info('wechat: HTTP routes registered');
  }

  /**
   */
  async init(groups: Array<WechatChannelGroup>) {
    const all = await listSavedAccounts(this.dataDir);
    if (all.size === 0) {
      logger.info('wechat: 没有任何账户信息, skipping');
      return;
    }

    for (const group of groups) {
      if (!group.accountIds?.length) {
        logger.info({ group: group.name }, 'wechat: channel group has no accountIds, skipping');
        continue;
      }
      for (const accountId of group.accountIds) {
        if (this.connections.has(accountId)) {
          logger.debug({ accountId, group: group.name }, 'wechat: account already connected');
          continue;
        }
        const cred = all.get(accountId);
        if (!cred) {
          logger.warn(
            { accountId, group: group.name },
            'wechat: credential not in cache, skipping',
          );
          continue;
        }
        this.groupNames.add(group.name);
        this.addAccount({ accountId: cred.accountId, token: cred.token, groupName: group.name });
        all.delete(accountId);
        logger.info({ accountId, group: group.name }, 'wechat: account connected');
      }
    }

    this.groupNames.add(WechatAdapter.defaultGroupName);
    all.forEach((cred) => {
      this.addAccount({
        accountId: cred.accountId,
        token: cred.token,
        groupName: WechatAdapter.defaultGroupName,
      });
    });
  }

  /** Reply to a message that was received via a known AccountConnection. */
  async reply(message: IrisMessage): Promise<void> {
    const channelUserId = message.channelUserId;
    const accountId = channelUserId.split(':')[0];
    const toUserId = channelUserId.split(':')[1];
    const conn = this.connections.get(accountId);
    if (!conn) {
      logger.error({ channelUserId }, 'wechat: no connection for accountId');
      return;
    }

    const text = extractTextFromContentParts(message.content);
    if (text) await conn.sendText(toUserId, text);

    for (const part of message.content) {
      try {
        if (part.type === 'image_url' && part.image_url.url.startsWith('data:')) {
          const comma = part.image_url.url.indexOf(',');
          if (comma < 0) continue;
          const base64 = part.image_url.url.slice(comma + 1);
          const buf = Buffer.from(base64, 'base64');
          await conn.sendFile(toUserId, buf, part.image_url.detail ?? 'image', 'image/*');
          continue;
        }
        if (part.type === 'input_audio') {
          const buf = Buffer.from(part.input_audio.data, 'base64');
          await conn.sendFile(toUserId, buf, 'audio', part.input_audio.format ?? 'audio/*');
          continue;
        }
        if (part.type === 'file' && part.file.file_data) {
          const buf = Buffer.from(part.file.file_data, 'base64');
          await conn.sendFile(
            toUserId,
            buf,
            part.file.filename ?? 'file',
            part.file.mimetype ?? 'application/octet-stream',
          );
        }
      } catch (err) {
        logger.error({ err }, 'wechat: failed to send content part');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic account management
  // -------------------------------------------------------------------------

  /**
   * Add a new account at runtime and immediately start polling.
   * Safe to call again with the same accountId (will replace the old connection).
   */
  addAccount(cfg: WechatAccountConfig): void {
    const existing = this.connections.get(cfg.accountId);
    if (existing) {
      existing.stop();
    }
    const conn = this._createConnection({
      ...cfg,
      dmPolicy: cfg.dmPolicy ?? this.dmPolicy,
      groupPolicy: cfg.groupPolicy ?? this.groupPolicy,
      allowFrom: cfg.allowFrom ?? this.allowFrom,
      groupAllowFrom: cfg.groupAllowFrom ?? this.groupAllowFrom,
      dataDir: cfg.dataDir ?? this.dataDir,
    });
    conn.start();
    logger.info({ accountId: cfg.accountId }, 'wechat: account added dynamically');
  }

  /** Stop and remove an account connection. */
  removeAccount(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (conn) {
      conn.stop();
      this.connections.delete(accountId);
      logger.info({ accountId }, 'wechat: account removed');
    }
  }

  listAccounts(): string[] {
    return Array.from(this.connections.keys());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _createConnection(cfg: WechatAccountConfig): AccountConnection {
    const conn = new AccountConnection(cfg, this.messageHandler);
    this.connections.set(cfg.accountId, conn);
    return conn;
  }

  /**
   * Register QR-login HTTP routes.
   *
   * GET  /wechat/qr/new             – start a new QR login session
   * GET  /wechat/qr/status/:sid     – poll login status for a session
   * GET  /wechat/accounts           – list saved accounts from disk
   * POST /wechat/accounts/:id/remove – stop and remove a running account
   */
  private _registerRoutes(server: RegisterServer): void {
    /**
     * GET /wechat/qr/new
     *
     * Starts a QR login session. Returns:
     * {
     *   sid: string,         // session ID for subsequent polling
     *   imageUrl: string,    // data URI or HTTPS URL for the QR image
     *   qrcode: string,      // raw QR value (for custom rendering)
     * }
     */
    server.get('/wechat/qr/new', async (_req, reply) => {
      try {
        const qrInfo: QrCodeInfo = await fetchQrCode();
        const sid = Math.random().toString(36).slice(2, 10);

        const session: QrSession = {
          qrcode: qrInfo.qrcode,
          imageUrl: qrInfo.imageUrl,
          baseUrl: qrInfo.baseUrl,
          status: 'wait',
          createdAt: Date.now(),
        };
        this.qrSessions.set(sid, session);

        // Background: keep polling until confirmed / expired / timeout
        this._bgPollQr(sid).catch((err: Error) => {
          logger.error({ sid, err }, 'wechat: QR background poll failed');
          const s = this.qrSessions.get(sid);
          if (s) {
            s.status = 'error';
            s.error = String(err);
          }
        });

        const html = buildQrPage(sid, qrInfo.imageUrl);
        return reply.type('text/html; charset=utf-8').send(html);
      } catch (err) {
        logger.error({ err }, 'wechat: failed to fetch QR code');
        return reply.status(502).send({ error: String(err) });
      }
    });

    /**
     * GET /wechat/qr/status/:sid
     *
     * Returns current login status for a QR session.
     * {
     *   status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error',
     *   imageUrl?: string,   // present if QR was refreshed
     *   accountId?: string,  // present when status === 'confirmed'
     *   error?: string,
     * }
     */
    server.get('/wechat/qr/status/:sid', async (req, reply) => {
      const { sid } = req.params as { sid: string };
      const session = this.qrSessions.get(sid);
      if (!session) {
        return reply.status(404).send({ error: 'QR session not found' });
      }

      const body: Record<string, unknown> = {
        status: session.status,
        imageUrl: session.imageUrl,
      };
      if (session.status === 'confirmed' && session.credential) {
        body['accountId'] = session.credential.accountId;
      }
      if (session.status === 'error') {
        body['error'] = session.error;
      }
      return reply.send(body);
    });

    // /**
    //  * GET /wechat/accounts
    //  *
    //  * Returns list of all saved credentials on disk + currently running accounts.
    //  */
    // server.get('/wechat/accounts', async (_req, reply) => {
    //   const saved = await listSavedAccounts(self.dataDir);
    //   const running = self.listAccounts();
    //   return reply.send({
    //     saved: saved.map((c) => ({
    //       accountId: c.accountId,
    //       userId: c.userId,
    //       baseUrl: c.baseUrl,
    //       savedAt: c.savedAt,
    //     })),
    //     running,
    //   });
    // });

    // /**
    //  * POST /wechat/accounts/:id/remove
    //  *
    //  * Stop and remove a running account connection.
    //  */
    // server.post('/wechat/accounts/:id/remove', async (req, reply) => {
    //   const { id } = req.params as { id: string };
    //   self.removeAccount(id);
    //   return reply.send({ ok: true });
    // });

    logger.info({ channel: this.name }, 'wechat: QR-login routes registered');
  }

  // -------------------------------------------------------------------------
  // Background QR polling
  // -------------------------------------------------------------------------

  private async _bgPollQr(sid: string): Promise<void> {
    const TIMEOUT_MS = 480_000;
    const POLL_INTERVAL_MS = 1_500;
    const MAX_REFRESHES = 3;

    const session = this.qrSessions.get(sid);
    if (!session) return;

    const deadline = Date.now() + TIMEOUT_MS;
    let refreshCount = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const s = this.qrSessions.get(sid);
      if (!s) return; // session was cleared

      let result;
      try {
        result = await pollQrStatusOnce(s.qrcode, s.baseUrl);
      } catch (err) {
        logger.warn({ sid, err }, 'wechat: QR poll error, retrying');
        continue;
      }

      switch (result.status) {
        case 'wait':
          break;

        case 'scaned':
          s.status = 'scaned';
          break;

        case 'redirect':
          s.baseUrl = result.newBaseUrl;
          break;

        case 'expired': {
          refreshCount++;
          if (refreshCount > MAX_REFRESHES) {
            s.status = 'expired';
            return;
          }
          logger.info({ sid, refreshCount }, 'wechat: QR expired, fetching new QR');
          try {
            const fresh = await fetchQrCode();
            s.qrcode = fresh.qrcode;
            s.imageUrl = fresh.imageUrl;
            s.baseUrl = fresh.baseUrl;
            s.status = 'wait';
          } catch (err) {
            s.status = 'error';
            s.error = `QR refresh failed: ${String(err)}`;
            return;
          }
          break;
        }

        case 'confirmed': {
          const { credential } = result;

          // Persist to disk
          await saveCredential(this.dataDir, credential);

          // Dynamically add the account to this adapter
          this.addAccount({
            accountId: credential.accountId,
            token: credential.token,
            groupName: WechatAdapter.defaultGroupName,
          });

          s.status = 'confirmed';
          s.credential = credential;

          logger.info(
            { accountId: credential.accountId },
            'wechat: QR login confirmed, account started',
          );
          return;
        }
      }
    }

    const s = this.qrSessions.get(sid);
    if (s && s.status === 'wait') {
      s.status = 'expired';
    }
  }
}

// ---------------------------------------------------------------------------
// HTML page builder
// ---------------------------------------------------------------------------

function buildQrPage(sid: string, imageUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>微信登录授权 · Iris</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f0f2f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1a1a1a;
    }

    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,.10);
      padding: 40px 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      max-width: 340px;
      width: 92%;
      text-align: center;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-icon {
      width: 40px; height: 40px;
      background: #07c160;
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
    }
    .logo-icon svg { width: 24px; height: 24px; fill: #fff; }
    .logo-text { font-size: 20px; font-weight: 600; }

    /* ── 非微信提示视图 ── */
    #view-non-wechat { display: none; flex-direction: column; align-items: center; gap: 20px; }

    .warn-icon {
      width: 64px; height: 64px;
      background: #fff7e6;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .warn-icon svg { width: 36px; height: 36px; }

    #view-non-wechat h2 { font-size: 17px; font-weight: 600; color: #333; }
    #view-non-wechat p  { font-size: 13px; color: #888; line-height: 1.7; }

    .steps {
      background: #f7f8fa;
      border-radius: 10px;
      padding: 14px 18px;
      text-align: left;
      width: 100%;
      font-size: 13px;
      color: #555;
      line-height: 2;
    }
    .steps b { color: #07c160; }

    /* ── 微信授权视图 ── */
    #view-wechat { display: none; flex-direction: column; align-items: center; gap: 20px; }

    #view-wechat h2 { font-size: 17px; font-weight: 600; color: #333; }
    #view-wechat p  { font-size: 13px; color: #888; line-height: 1.7; }

    .btn {
      width: 100%;
      padding: 14px 0;
      border: none; border-radius: 28px;
      font-size: 16px; font-weight: 500;
      cursor: pointer;
      transition: opacity .15s, transform .1s;
    }
    .btn:active { opacity: .85; transform: scale(.98); }

    .btn-primary { background: #07c160; color: #fff; }
    .btn-secondary {
      background: #f0f2f5; color: #555;
      font-size: 14px; margin-top: -8px;
    }

    /* ── 成功视图 ── */
    #view-success { display: none; flex-direction: column; align-items: center; gap: 16px; }

    .success-icon {
      width: 72px; height: 72px;
      background: #e8f9ef;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .success-icon svg { width: 40px; height: 40px; }

    #view-success h2 { font-size: 18px; font-weight: 600; color: #07c160; }
    #view-success p  { font-size: 13px; color: #888; }

    /* ── 过期 / 错误视图 ── */
    #view-expired, #view-error {
      display: none; flex-direction: column; align-items: center; gap: 16px;
    }
    #view-expired h2, #view-error h2 { font-size: 17px; font-weight: 600; color: #555; }
    #view-error h2 { color: #e53e3e; }
    #view-expired p, #view-error p { font-size: 13px; color: #999; }

    /* loading spinner */
    #view-loading { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid #e8e8e8;
      border-top-color: #07c160;
      border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #view-loading p { font-size: 13px; color: #aaa; }

    /* polling dot */
    .poll-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #aaa; }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #07c160;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dot.off { animation: none; background: #ccc; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
  </style>
</head>
<body>
<div class="card">

  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24"><path d="M9.5 4C5.36 4 2 6.91 2 10.5c0 1.99 1.03 3.77 2.66 4.97L4 18l2.87-1.44A8.8 8.8 0 0 0 9.5 17c.34 0 .67-.02 1-.06C10.18 16.28 10 15.4 10 14.5 10 10.91 13.36 8 17.5 8c.34 0 .67.02 1 .06C17.73 5.65 13.95 4 9.5 4zm-2 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm6 2c-3.31 0-6 2.24-6 5s2.69 5 6 5c.8 0 1.56-.15 2.25-.42L22 21l-.54-2.45C22.44 17.57 23.5 16.1 23.5 14.5c0-2.76-2.19-4.5-6-4.5zm-1.5 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>
    </div>
    <span class="logo-text">Iris · 微信</span>
  </div>

  <!-- 初始 loading -->
  <div id="view-loading">
    <div class="spinner"></div>
    <p>正在初始化…</p>
  </div>

  <!-- 非微信环境 -->
  <div id="view-non-wechat">
    <div class="warn-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fa8c16" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
      </svg>
    </div>
    <h2>请在微信中打开此页面</h2>
    <p>此页面需要在微信内置浏览器中打开，才能完成账号授权。</p>
    <div class="steps">
      <b>①</b> 点击下方按钮复制链接<br/>
      <b>②</b> 打开微信 → 发送给文件传输助手<br/>
      <b>③</b> 在微信中点击链接即可完成授权
    </div>
    <button class="btn btn-primary" id="btn-copy" onclick="copyLink()">点我复制链接</button>
  </div>

  <!-- 微信内：立即授权 -->
  <div id="view-wechat">
    <h2>连接你的微信账号</h2>
    <p>点击下方按钮，在微信中完成授权，即可将此账号接入 Iris。</p>
    <button class="btn btn-primary" id="btn-auth">立即授权</button>
    <div class="poll-row">
      <span class="dot" id="dot"></span>
      <span id="status-text">等待授权…</span>
    </div>
    <button class="btn btn-secondary" id="btn-refresh" style="display:none"
            onclick="location.href='/wechat/qr/new'">重新获取授权链接</button>
  </div>

  <!-- 成功 -->
  <div id="view-success">
    <div class="success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#07c160" stroke-width="2.5">
        <path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>
      </svg>
    </div>
    <h2>授权成功！</h2>
    <p id="success-detail">账号已成功连接到 Iris。</p>
  </div>

  <!-- 过期 -->
  <div id="view-expired">
    <div class="warn-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fa8c16" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
      </svg>
    </div>
    <h2>授权链接已过期</h2>
    <p>请重新获取授权链接后再试。</p>
    <button class="btn btn-primary" onclick="location.href='/wechat/qr/new'">重新获取</button>
  </div>

  <!-- 错误 -->
  <div id="view-error">
    <div class="warn-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>
      </svg>
    </div>
    <h2>出现了一些问题</h2>
    <p id="error-detail">请稍后重试。</p>
    <button class="btn btn-primary" onclick="location.href='/wechat/qr/new'">重试</button>
  </div>

</div>

<script>
  var AUTH_URL = ${JSON.stringify(imageUrl)};


  // ── 复制链接 ──
  function copyLink() {
    var btn = document.getElementById('btn-copy');
    function onSuccess() {
      if (btn) { btn.textContent = '已复制！'; setTimeout(function(){ btn.textContent = '点我复制链接'; }, 2000); }
    }
    function onFail() {
      // 降级：选中一个临时 textarea
      var ta = document.createElement('textarea');
      ta.value = AUTH_URL;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); onSuccess(); } catch(e) { alert(AUTH_URL); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(AUTH_URL).then(onSuccess, onFail);
    } else {
      onFail();
    }
  }

(function () {
  var sid = ${JSON.stringify(sid)};
  var POLL_INTERVAL = 1500;

  // ── 视图切换 ──
  var views = ['loading','non-wechat','wechat','success','expired','error'];
  function show(name) {
    views.forEach(function(v) {
      var el = document.getElementById('view-' + v);
      if (el) el.style.display = (v === name) ? 'flex' : 'none';
    });
  }

  // ── 微信 UA 检测 ──
  var ua = navigator.userAgent;
  var isWechat = /MicroMessenger/i.test(ua);

  if (!isWechat) {
    show('non-wechat');
  } else {
    show('wechat');
    document.getElementById('btn-auth').addEventListener('click', function() {
      location.href = AUTH_URL;
    });
    startPoll();
  }

  // ── 轮询 ──
  function startPoll() {
    setTimeout(poll, POLL_INTERVAL);
  }

  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var btnRefresh = document.getElementById('btn-refresh');

  function setStatus(msg, active) {
    if (statusText) statusText.textContent = msg;
    if (dot) dot.classList.toggle('off', !active);
  }

  async function poll() {
    try {
      var res = await fetch('/wechat/qr/status/' + sid);
      var data = await res.json();

      switch (data.status) {
        case 'wait':
          setStatus('等待授权…', true);
          break;

        case 'scaned':
          setStatus('已扫码，请在微信中确认', true);
          break;

        case 'confirmed':
          show('success');
          var detail = document.getElementById('success-detail');
          if (detail && data.accountId) {
            detail.textContent = '账号 ' + data.accountId + ' 已成功连接到 Iris。';
          }
          return; // 停止轮询

        case 'expired':
          show('expired');
          return;

        case 'error':
          show('error');
          var errDetail = document.getElementById('error-detail');
          if (errDetail) errDetail.textContent = data.error || '请稍后重试。';
          return;
      }
    } catch (e) {
      console.warn('poll error', e);
    }
    setTimeout(poll, POLL_INTERVAL);
  }
})();
</script>
</body>
</html>`;
}
