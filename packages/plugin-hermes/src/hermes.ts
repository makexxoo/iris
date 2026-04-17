import { logger } from './logger';

export interface HermesConfig {
  /** Base URL of hermes-agent api_server, e.g. "http://localhost:8642" */
  baseUrl: string;
  /** API key (API_SERVER_KEY in hermes-agent). Required for session continuity. */
  apiKey?: string;
  /** Model name to pass in requests (cosmetic, hermes ignores it). Defaults to "hermes". */
  model?: string;
  /** Request timeout in ms. Defaults to 300000 (5 min). */
  timeoutMs?: number;
}

export interface IrisWsMessage {
  type: 'message';
  id: string;
  channel: string;
  channelUserId: string;
  sessionId: string;
  content: { type: string; text?: string };
  timestamp: number;
  context?: Record<string, unknown>;
}

/**
 * Send one message to hermes-agent's OpenAI-compatible api_server and return the reply text.
 *
 * hermes-agent maintains conversation history keyed by X-Hermes-Session-Id,
 * so we pass the iris sessionId to preserve per-user context across turns.
 */
export async function queryHermes(
  msg: IrisWsMessage,
  config: HermesConfig,
): Promise<string> {
  const { baseUrl, apiKey, model = 'hermes', timeoutMs = 300_000 } = config;

  const text = msg.content.text ?? '';

  const messages: Array<{ role: string; content: string }> = [];

  // Inject iris plugin context if present
  if (msg.context && Object.keys(msg.context).length > 0) {
    messages.push({
      role: 'system',
      content: `[Context from iris pipeline]\n${JSON.stringify(msg.context, null, 2)}`,
    });
  }

  messages.push({ role: 'user', content: text });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Pass iris sessionId so hermes-agent loads per-user conversation history
    'X-Hermes-Session-Id': msg.sessionId,
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new Error(
      `hermes api_server request failed (${err?.name === 'AbortError' ? 'timeout' : err?.message})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`hermes api_server returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const reply: string = data?.choices?.[0]?.message?.content ?? '';

  if (!reply) {
    logger.warn({ sessionId: msg.sessionId }, 'hermes returned empty reply');
  }

  logger.info({ sessionId: msg.sessionId, chars: reply.length }, 'hermes reply received');

  return reply;
}
