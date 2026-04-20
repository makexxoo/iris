// packages/plugin-hermes/src/media.ts
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const SUPPORTED_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|mp4|mov|avi|mkv|webm|ogg|opus|mp3|wav|m4a|pdf|docx?|xlsx?|pptx?|zip|tar|gz|bin)$/i;

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

function normalizeCandidatePath(raw: string): string {
  let normalized = raw.replace(/^[`"']|[`"']$/g, '').trim();
  // Handle JSON-escaped/newline-concatenated cases like:
  // MEDIA:/tmp/a.jpeg\n/tmp/a.jpeg
  normalized = normalized.split(/\\[nr]|[\r\n]/, 1)[0]?.trim() ?? '';
  return normalized;
}

function canUsePath(filePath: string): boolean {
  return Boolean(filePath) && SUPPORTED_EXT_RE.test(filePath);
}

function maybeAddFile(
  filePath: string,
  files: ExtractedFile[],
  seenPaths: Set<string>,
  log?: (msg: string) => void,
): void {
  if (!canUsePath(filePath) || seenPaths.has(filePath)) return;
  if (!existsSync(filePath)) {
    log?.(`media file not found, skipping: ${filePath}`);
    return;
  }

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    log?.(`cannot stat media file, skipping: ${filePath}`);
    return;
  }

  if (size > MAX_FILE_BYTES) {
    log?.(`media file too large (${size} bytes), skipping: ${filePath}`);
    return;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    log?.(`cannot read media file, skipping: ${filePath}`);
    return;
  }

  const mime = mimeFromPath(filePath);
  files.push({
    fileName: basename(filePath),
    mimeType: mime,
    base64: bytes.toString('base64'),
    attachmentType: attachmentType(mime),
  });
  seenPaths.add(filePath);
}

export function extractMedia(text: string, log?: (msg: string) => void): ExtractResult {
  const files: ExtractedFile[] = [];
  const seenPaths = new Set<string>();

  for (const match of text.matchAll(MEDIA_PATTERN)) {
    const raw = match.groups?.path ?? '';
    const filePath = normalizeCandidatePath(raw);
    maybeAddFile(filePath, files, seenPaths, log);
  }

  // Remove all MEDIA: tags from text in one pass (mirrors hermes-agent's media_pattern.sub('', cleaned))
  let cleaned = MEDIA_PATTERN.source
    ? text.replace(new RegExp(MEDIA_PATTERN.source, MEDIA_PATTERN.flags), '').replace(/\n{3,}/g, '\n\n').trim()
    : text;

  // Fallback 1: markdown links to local paths (both image and regular links).
  // Example: ![Snapshot](/app/data/...jpeg) or [Snapshot](/app/data/...jpeg)
  const mdLocalLinkPattern = /!?\[[^\]]*\]\((?<path>(?:~\/|\/)[^)]+)\)/g;
  for (const match of cleaned.matchAll(mdLocalLinkPattern)) {
    const candidate = normalizeCandidatePath(match.groups?.path ?? '');
    maybeAddFile(candidate, files, seenPaths, log);
  }
  cleaned = cleaned.replace(mdLocalLinkPattern, '').replace(/\n{3,}/g, '\n\n').trim();

  // Fallback 2: bare local paths in plain text.
  const localPathPattern = /(?<![:/\w.])(?<path>(?:~\/|\/)(?:[\w.\-]+\/)*[\w.\-]+\.(?:png|jpe?g|gif|webp|mp4|mov|avi|mkv|webm|ogg|opus|mp3|wav|m4a|pdf|docx?|xlsx?|pptx?|zip|tar|gz|bin))\b/gi;
  for (const match of cleaned.matchAll(localPathPattern)) {
    const candidate = normalizeCandidatePath(match.groups?.path ?? '');
    maybeAddFile(candidate, files, seenPaths, log);
  }
  cleaned = cleaned.replace(localPathPattern, '').replace(/\n{3,}/g, '\n\n').trim();

  return { text: cleaned, files };
}
