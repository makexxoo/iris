/**
 * iLink Bot QR-code login flow.
 *
 * Exposes two async helpers:
 *  - fetchQrCode()   – call iLink to get a fresh QR code image and value
 *  - pollQrStatus()  – poll until the user confirms (or times out / expires)
 *
 * Credential persistence uses a local JSON file at:
 *   <dataDir>/wechat/accounts/<accountId>.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import pino from 'pino';

const logger = pino({ name: 'channel-wechat:qr-login' });

// ---------------------------------------------------------------------------
// iLink constants (shared with account-connection.ts but kept local to avoid
// a circular import – they are small string/number constants)
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const CHANNEL_VERSION = '2.2.0';

const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';

const QR_TIMEOUT_MS = 35_000;
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QrCodeInfo {
  /** Opaque QR code value used when polling status */
  qrcode: string;
  /** Base URL to use when polling (may change on redirect) */
  baseUrl: string;
  /**
   * Data URL (data:image/png;base64,...) or HTTPS URL for the QR image.
   * Use this to render the QR in the browser.
   */
  imageUrl: string;
}

export interface WechatCredential {
  accountId: string;
  token: string;
  baseUrl: string;
  userId: string;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ilinkHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

async function apiGet(url: string): Promise<Record<string, unknown>> {
  const res = await axios.get<Record<string, unknown>>(url, {
    headers: ilinkHeaders(),
    timeout: QR_TIMEOUT_MS,
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// QR code fetch
// ---------------------------------------------------------------------------

/**
 * Fetch a new QR code from the iLink Bot API.
 * @param botType  "3" is the standard personal-account bot type.
 */
export async function fetchQrCode(botType = '3'): Promise<QrCodeInfo> {
  const url = `${ILINK_BASE_URL}/${EP_GET_BOT_QR}?bot_type=${botType}`;
  const data = await apiGet(url);

  const qrcode = String(data['qrcode'] ?? '');
  if (!qrcode) {
    throw new Error('iLink get_bot_qrcode: missing qrcode field in response');
  }

  const imageUrl = String(data['qrcode_img_content'] ?? qrcode);

  return { qrcode, baseUrl: ILINK_BASE_URL, imageUrl };
}

// ---------------------------------------------------------------------------
// QR status poll
// ---------------------------------------------------------------------------

export type QrPollStatus =
  | { status: 'wait' }
  | { status: 'scaned' }
  | { status: 'redirect'; newBaseUrl: string }
  | { status: 'expired' }
  | { status: 'confirmed'; credential: WechatCredential };

/**
 * Poll the iLink status endpoint once.
 * Returns a discriminated union describing the current scan state.
 */
export async function pollQrStatusOnce(qrcode: string, baseUrl: string): Promise<QrPollStatus> {
  const url = `${baseUrl.replace(/\/$/, '')}/${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`;
  const data = await apiGet(url);
  const status = String(data['status'] ?? 'wait');

  switch (status) {
    case 'wait':
      return { status: 'wait' };

    case 'scaned':
      return { status: 'scaned' };

    case 'scaned_but_redirect': {
      const host = String(data['redirect_host'] ?? '');
      return { status: 'redirect', newBaseUrl: host ? `https://${host}` : baseUrl };
    }

    case 'expired':
      return { status: 'expired' };

    case 'confirmed': {
      const accountId = String(data['ilink_bot_id'] ?? '');
      const token = String(data['bot_token'] ?? '');
      const credBaseUrl = String(data['baseurl'] ?? ILINK_BASE_URL);
      const userId = String(data['ilink_user_id'] ?? '');

      if (!accountId || !token) {
        throw new Error('iLink QR confirmed but credential payload is incomplete');
      }

      return {
        status: 'confirmed',
        credential: {
          accountId,
          token,
          baseUrl: credBaseUrl,
          userId,
          savedAt: new Date().toISOString(),
        },
      };
    }

    default:
      return { status: 'wait' };
  }
}

// ---------------------------------------------------------------------------
// Credential persistence
// ---------------------------------------------------------------------------

function accountFilePath(dataDir: string, accountId: string): string {
  return path.join(dataDir, `${accountId}.json`);
}

export async function saveCredential(dataDir: string, credential: WechatCredential): Promise<void> {
  const filePath = accountFilePath(dataDir, credential.accountId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Write atomically: write to temp file then rename
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(credential, null, 2), 'utf8');
  await fs.rename(tmp, filePath);

  // Restrict file permissions (best-effort on all platforms)
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows will silently ignore
  }

  logger.info({ accountId: credential.accountId, path: filePath }, 'wechat credential saved');
}

export async function loadCredential(
  dataDir: string,
  accountId: string,
): Promise<WechatCredential | null> {
  const filePath = accountFilePath(dataDir, accountId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as WechatCredential;
  } catch {
    return null;
  }
}

export async function listSavedAccounts(dataDir: string): Promise<Map<string, WechatCredential>> {
  const dir = path.join(dataDir, 'wechat', 'accounts');
  const results: Map<string, WechatCredential> = new Map();
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const cred = JSON.parse(raw) as WechatCredential;
        results.set(cred.accountId, cred);
      } catch {
        // skip corrupted files
      }
    }
  } catch {
    /* empty */
  }
  return results;
}

// ---------------------------------------------------------------------------
// Full login flow (for programmatic use)
// ---------------------------------------------------------------------------

export interface QrLoginOptions {
  /** Data directory for persisting credentials. Defaults to ~/.iris */
  dataDir?: string;
  /** Seconds before giving up. Defaults to 480. */
  timeoutSeconds?: number;
  /** iLink bot type. Defaults to "3". */
  botType?: string;
  /** Called whenever the QR code changes (initial + refresh). */
  onQrCode?: (info: QrCodeInfo) => void;
  /** Called when the user scans the QR code (before confirming). */
  onScanned?: () => void;
}

/**
 * Full interactive QR login flow.
 *
 * Handles QR expiry (up to 3 refreshes) and base-URL redirects.
 * Returns credentials on success, throws on failure.
 */
export async function runQrLogin(options: QrLoginOptions = {}): Promise<WechatCredential> {
  const {
    dataDir = defaultDataDir(),
    timeoutSeconds = 480,
    botType = '3',
    onQrCode,
    onScanned,
  } = options;

  let qrInfo = await fetchQrCode(botType);
  onQrCode?.(qrInfo);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let refreshCount = 0;
  let currentBaseUrl = qrInfo.baseUrl;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let result: QrPollStatus;
    try {
      result = await pollQrStatusOnce(qrInfo.qrcode, currentBaseUrl);
    } catch (err) {
      logger.warn({ err }, 'QR status poll error, retrying');
      continue;
    }

    switch (result.status) {
      case 'wait':
        break;

      case 'scaned':
        onScanned?.();
        break;

      case 'redirect':
        currentBaseUrl = result.newBaseUrl;
        break;

      case 'expired':
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error('QR code expired too many times (>3), please try again');
        }
        logger.info({ refreshCount }, 'QR expired, fetching new QR code');
        qrInfo = await fetchQrCode(botType);
        currentBaseUrl = qrInfo.baseUrl;
        onQrCode?.(qrInfo);
        break;

      case 'confirmed': {
        const { credential } = result;
        await saveCredential(dataDir, credential);
        return credential;
      }
    }
  }

  throw new Error('QR login timed out');
}

export function defaultDataDir(): string {
  return path.join(process.env['HOME'] ?? process.cwd(), '.iris', 'wechat', 'accounts');
}
