// packages/plugin-hermes/src/media.ts
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Mirrors hermes-agent's extract_media() pattern */
const MEDIA_PATTERN =
  /[`"']?MEDIA:\s*(?<path>`[^`\n]+`|"[^"\n]+"|\S+\.(?:png|jpe?g|gif|webp|mp4|mov|avi|mkv|webm|ogg|opus|mp3|wav|m4a|pdf|docx?|xlsx?|pptx?|zip|tar|gz|bin|[a-zA-Z0-9]{1,10})(?=[\s`"',;:)\]}\n]|$))[`"']?/gi;

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

export interface ExtractedFile {
  fileName: string;
  mimeType: string;
  base64: string;
  attachmentType: 'image' | 'video' | 'audio' | 'file';
}

export interface ExtractResult {
  text: string;
  files: ExtractedFile[];
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase().replace('.', '');
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function attachmentType(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export function extractMedia(text: string, log?: (msg: string) => void): ExtractResult {
  const files: ExtractedFile[] = [];

  for (const match of text.matchAll(MEDIA_PATTERN)) {
    const raw = match.groups?.path ?? '';
    const filePath = raw.replace(/^[`"']|[`"']$/g, '').trim();

    if (!filePath) continue;
    if (!existsSync(filePath)) {
      log?.(`media file not found, skipping: ${filePath}`);
      continue;
    }

    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      log?.(`cannot stat media file, skipping: ${filePath}`);
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      log?.(`media file too large (${size} bytes), skipping: ${filePath}`);
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      log?.(`cannot read media file, skipping: ${filePath}`);
      continue;
    }

    const mime = mimeFromPath(filePath);
    files.push({
      fileName: basename(filePath),
      mimeType: mime,
      base64: bytes.toString('base64'),
      attachmentType: attachmentType(mime),
    });
  }

  // Remove all MEDIA: tags from text in one pass (mirrors hermes-agent's media_pattern.sub('', cleaned))
  const cleaned = MEDIA_PATTERN.source
    ? text.replace(new RegExp(MEDIA_PATTERN.source, MEDIA_PATTERN.flags), '').replace(/\n{3,}/g, '\n\n').trim()
    : text;

  return { text: cleaned, files };
}
