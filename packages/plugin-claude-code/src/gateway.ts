import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { extractTextFromContentParts, type IrisMessage } from '@agent-iris/protocol';
import type { SessionManager } from './session';
import { logger } from './logger';

/**
 * Resolve the absolute path of the `claude` CLI.
 * Priority:
 *  1. CLAUDE_PATH env var
 *  2. `which claude` / `where claude`
 *  3. Common install locations
 */
function resolveClaudePath(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  try {
    const result = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0]
      .trim();
    if (result && existsSync(result)) return result;
  } catch {
    // fall through
  }

  const candidates = [
    `${process.env.HOME}/.nvm/versions/node/v24.14.0/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    'Could not find `claude` CLI. Install it with `npm i -g @anthropic-ai/claude-code` or set CLAUDE_PATH.',
  );
}

const CLAUDE_BIN = resolveClaudePath();
logger.info({ claudeBin: CLAUDE_BIN }, 'resolved claude binary');

export type IrisWsMessage = IrisMessage;

interface StreamJsonMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  [key: string]: unknown;
}

/**
 * Invoke `claude --print` as a subprocess and collect the final result text.
 * Uses --output-format=stream-json to parse structured messages.
 */
async function runClaudeQuery(params: {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  maxTurns?: number;
}): Promise<{ resultText: string; sdkSessionId: string | undefined }> {
  const { prompt, cwd, resumeSessionId, maxTurns = 10 } = params;

  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    'bypassPermissions',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  args.push('--', prompt);

  logger.info({ claudeBin: CLAUDE_BIN, args, cwd }, 'spawning claude');

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    let resultText = '';
    let sdkSessionId: string | undefined;
    const stderrChunks: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      // Log stderr in real-time so we can see what claude is complaining about
      logger.warn({ stderr: chunk.toString() }, 'claude stderr');
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Log every line for diagnosis
      logger.debug({ raw: trimmed }, 'claude stdout line');

      let msg: StreamJsonMessage;
      try {
        msg = JSON.parse(trimmed) as StreamJsonMessage;
      } catch {
        logger.warn({ raw: trimmed }, 'claude stdout: non-JSON line');
        return;
      }

      logger.debug({ type: msg.type, subtype: msg.subtype }, 'claude message');

      if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
        sdkSessionId = msg.session_id;
        logger.info({ sdkSessionId }, 'claude session init');
      }

      if (msg.type === 'result') {
        // Log the full result message to see all fields
        logger.info({ resultMsg: msg }, 'claude result message');
        if (typeof msg.result === 'string') {
          resultText = msg.result;
        }
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      logger.info(
        { code, signal, resultText: resultText.slice(0, 200), sdkSessionId },
        'claude process closed',
      );

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      resolve({ resultText, sdkSessionId });
    });
  });
}

/**
 * Handle a single inbound iris message.
 * Enqueues the work so messages for the same sessionId are processed serially.
 */
export function handleIrisMessage(params: {
  msg: IrisWsMessage;
  sessionManager: SessionManager;
  cwd: string;
  sendReply: (sessionId: string, text: string) => void;
}): void {
  const { msg, sessionManager, cwd, sendReply } = params;
  const { sessionId } = msg;

  sessionManager.enqueue(sessionId, async () => {
    const prompt = extractTextFromContentParts(msg.content);
    if (!prompt) {
      logger.warn({ sessionId }, 'empty message text, skipping');
      return;
    }

    logger.info({ sessionId, prompt }, 'handling iris message');

    const state = sessionManager.getOrCreate(sessionId);

    try {
      const { resultText, sdkSessionId } = await runClaudeQuery({
        prompt,
        cwd,
        resumeSessionId: state.sdkSessionId,
        maxTurns,
      });

      if (sdkSessionId) {
        state.sdkSessionId = sdkSessionId;
      }

      if (!resultText) {
        logger.warn({ sessionId }, 'Claude Code returned empty result, skipping reply');
        return;
      }

      sendReply(sessionId, resultText);
    } catch (err) {
      logger.error({ err, sessionId }, 'Claude Code SDK error');
      sendReply(sessionId, `Error: ${String(err)}`);
    }
  });
}

// Default max turns — can be overridden per-call if needed
const maxTurns = Number(process.env.CLAUDE_MAX_TURNS ?? 10);
