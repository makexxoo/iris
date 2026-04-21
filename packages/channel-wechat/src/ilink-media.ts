// packages/channel-wechat/src/ilink-media.ts
import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import axios from 'axios';

// iLink media type constants (used in getuploadurl request)
export const MEDIA_IMAGE = 1;
export const MEDIA_VIDEO = 2;
export const MEDIA_FILE = 3;
export const MEDIA_VOICE = 4;

// iLink item type constants (used in sendmessage item_list)
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const API_TIMEOUT_MS = 15_000;
const CDN_UPLOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// AES-128-ECB with PKCS7 padding
// ---------------------------------------------------------------------------

function pkcs7Pad(data: Buffer, blockSize = 16): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  return Buffer.concat([data, padding]);
}

export function aes128EcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const padded = pkcs7Pad(plaintext);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function aesPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// CDN helpers
// ---------------------------------------------------------------------------

function cdnUploadUrl(uploadParam: string, filekey: string): string {
  const ep = encodeURIComponent(uploadParam);
  const fk = encodeURIComponent(filekey);
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${ep}&filekey=${fk}`;
}

async function uploadCiphertext(ciphertext: Buffer, uploadUrl: string): Promise<string> {
  const res = await axios.post(uploadUrl, ciphertext, {
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: CDN_UPLOAD_TIMEOUT_MS,
    responseType: 'arraybuffer',
  });
  const encryptedParam = (res.headers as Record<string, string>)['x-encrypted-param'];
  if (!encryptedParam) {
    throw new Error(`CDN upload missing x-encrypted-param header (status ${res.status})`);
  }
  return String(encryptedParam);
}

// ---------------------------------------------------------------------------
// iLink getuploadurl
// ---------------------------------------------------------------------------

interface UploadUrlParams {
  baseUrl: string;
  token: string;
  toUserId: string;
  mediaType: number;
  filekey: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskeyHex: string;
  buildHeaders: (token: string, body: string) => Record<string, string>;
}

async function getUploadUrl(
  p: UploadUrlParams,
): Promise<{ uploadParam: string; uploadFullUrl: string }> {
  const payload = {
    filekey: p.filekey,
    media_type: p.mediaType,
    to_user_id: p.toUserId,
    rawsize: p.rawsize,
    rawfilemd5: p.rawfilemd5,
    filesize: p.filesize,
    no_need_thumb: true,
    aeskey: p.aeskeyHex,
    base_info: { channel_version: '2.2.0' },
  };
  const body = JSON.stringify(payload);
  const url = `${p.baseUrl.replace(/\/$/, '')}/ilink/bot/getuploadurl`;
  const res = await axios.post<Record<string, unknown>>(url, body, {
    headers: p.buildHeaders(p.token, body),
    timeout: API_TIMEOUT_MS,
  });
  return {
    uploadParam: String(res.data['upload_param'] ?? ''),
    uploadFullUrl: String(res.data['upload_full_url'] ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Media item builders — mirrors hermes-agent _outbound_media_builder()
// ---------------------------------------------------------------------------

function buildMediaItem(
  mimeType: string,
  fileName: string,
  encryptedQueryParam: string,
  aesKeyForApi: string,
  ciphertextSize: number,
  plaintextSize: number,
  rawfilemd5: string,
): { mediaType: number; item: Record<string, unknown> } {
  const media = {
    encrypt_query_param: encryptedQueryParam,
    aes_key: aesKeyForApi,
    encrypt_type: 1,
  };

  if (mimeType.startsWith('image/')) {
    return {
      mediaType: MEDIA_IMAGE,
      item: { type: ITEM_IMAGE, image_item: { media, mid_size: ciphertextSize } },
    };
  }
  if (mimeType.startsWith('video/')) {
    return {
      mediaType: MEDIA_VIDEO,
      item: {
        type: ITEM_VIDEO,
        video_item: { media, video_size: ciphertextSize, play_length: 0, video_md5: rawfilemd5 },
      },
    };
  }
  if (mimeType.startsWith('audio/') || fileName.endsWith('.silk')) {
    return {
      mediaType: MEDIA_VOICE,
      item: { type: ITEM_VOICE, voice_item: { media, playtime: 0 } },
    };
  }
  return {
    mediaType: MEDIA_FILE,
    item: {
      type: ITEM_FILE,
      file_item: { media, file_name: fileName, len: String(plaintextSize) },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendFileParams {
  baseUrl: string;
  token: string;
  toUserId: string;
  fileBytes: Buffer;
  fileName: string;
  mimeType: string;
  contextToken: string | null;
  clientId: string;
  buildHeaders: (token: string, body: string) => Record<string, string>;
}

/**
 * Encrypt a file with AES-128-ECB, upload to iLink CDN, and return the
 * item_list entry ready for use in a sendmessage payload.
 *
 * aeskey encoding: iLink expects base64(hex_string_of_key), not base64(raw_bytes).
 * This matches hermes-agent's weixin.py exactly.
 */
export async function uploadAndBuildItem(p: SendFileParams): Promise<Record<string, unknown>> {
  const aesKey = randomBytes(16);
  const rawsize = p.fileBytes.length;
  const rawfilemd5 = createHash('md5').update(p.fileBytes).digest('hex');
  const ciphertext = aes128EcbEncrypt(p.fileBytes, aesKey);
  const filekey = randomBytes(16).toString('hex');

  // iLink expects aeskey as base64(hex_string), not base64(raw_bytes)
  const aeskeyHex = aesKey.toString('hex');

  const { mediaType, item } = buildMediaItem(
    p.mimeType,
    p.fileName,
    '', // placeholder — filled after upload
    '', // placeholder
    ciphertext.length,
    rawsize,
    rawfilemd5,
  );

  const { uploadParam, uploadFullUrl } = await getUploadUrl({
    baseUrl: p.baseUrl,
    token: p.token,
    toUserId: p.toUserId,
    mediaType,
    filekey,
    rawsize,
    rawfilemd5,
    filesize: aesPaddedSize(rawsize),
    aeskeyHex,
    buildHeaders: p.buildHeaders,
  });

  if (!uploadFullUrl && !uploadParam) {
    throw new Error('getuploadurl returned neither upload_param nor upload_full_url');
  }
  const uploadUrl = uploadFullUrl || cdnUploadUrl(uploadParam, filekey);

  const encryptedQueryParam = await uploadCiphertext(ciphertext, uploadUrl);

  // iLink expects aes_key as base64(hex_string_of_key) — same as aeskeyHex but base64-encoded
  const aesKeyForApi = Buffer.from(aeskeyHex, 'ascii').toString('base64');

  // Patch encrypt_query_param and aes_key into the media object inside the item
  const itemValues = Object.values(item).filter(
    (v): v is Record<string, unknown> => !!v && typeof v === 'object' && 'media' in (v as object),
  );
  for (const sub of itemValues) {
    const media = sub['media'] as Record<string, unknown>;
    media['encrypt_query_param'] = encryptedQueryParam;
    media['aes_key'] = aesKeyForApi;
  }

  return item;
}
