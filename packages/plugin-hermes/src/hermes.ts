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
  content: Array<
    | {
        type: 'text';
        text: string;
      }
    | {
        type: 'image_url';
        image_url: { url: string; detail?: string };
      }
  >;
  timestamp: number;
  context?: Record<string, unknown>;
}

function buildRequestHeaders(msg: IrisWsMessage, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Keep passing sessionId for compatibility with chat/completions mode.
    'X-Hermes-Session-Id': msg.sessionId,
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function extractTextFromContent(content: IrisWsMessage['content']): string {
  return content
    .filter((part): part is Extract<IrisWsMessage['content'][number], { type: 'text' }> => {
      return part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function collectResponseText(data: any): string {
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts: string[] = [];

  for (const item of output) {
    const itemType = String(item?.type ?? '');
    if (itemType === 'output_text') {
      const text = typeof item?.text === 'string' ? item.text : '';
      if (text) parts.push(text);
      continue;
    }
    if (itemType === 'function_call_output') {
      const out = item?.output;
      if (typeof out === 'string' && out) {
        parts.push(out);
      } else if (out != null) {
        try {
          parts.push(JSON.stringify(out));
        } catch {
          parts.push(String(out));
        }
      }
    }
  }

  if (parts.length > 0) {
    return parts.join('\n');
  }

  // Compatibility fallback for responses-like payloads that only expose output_text.
  const outputText = typeof data?.output_text === 'string' ? data.output_text : '';
  if (outputText) return outputText;

  // Last-resort fallback: chat/completions style.
  return data?.choices?.[0]?.message?.content ?? '';
}

async function queryViaResponses(
  msg: IrisWsMessage,
  config: HermesConfig,
  signal: AbortSignal,
): Promise<string> {
  const { baseUrl, apiKey, model = 'hermes' } = config;
  const base = baseUrl.replace(/\/$/, '');
  const inputItems: Array<{ role: string; content: string }> = [];

  if (msg.context && Object.keys(msg.context).length > 0) {
    inputItems.push({
      role: 'system',
      content: `[Context from iris pipeline]\n${JSON.stringify(msg.context, null, 2)}`,
    });
  }
  inputItems.push({ role: 'user', content: extractTextFromContent(msg.content) });

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: buildRequestHeaders(msg, apiKey),
    body: JSON.stringify({
      model,
      input: inputItems,
      // Let api_server maintain response chaining per iris session.
      conversation: msg.sessionId,
      store: true,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`responses endpoint returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await response.json()) as any;
  logger.info({ data }, '智能体返回的完整数据(responses)');
  return collectResponseText(data);
}

/**
 * Send one message to hermes-agent's OpenAI-compatible api_server and return the reply text.
 *
 * hermes-agent maintains conversation history keyed by X-Hermes-Session-Id,
 * so we pass the iris sessionId to preserve per-user context across turns.
 */
export async function queryHermes(msg: IrisWsMessage, config: HermesConfig): Promise<string> {
  const { timeoutMs = 300_000 } = config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prefer /v1/responses because it carries structured output items
    // (including function_call_output), which often contain MEDIA tags.
    const reply = await queryViaResponses(msg, config, controller.signal);
    if (!reply) {
      logger.warn({ sessionId: msg.sessionId }, 'responses endpoint returned empty reply');
    }
    logger.info({ sessionId: msg.sessionId, chars: reply.length }, 'hermes reply received');
    return reply;
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err);
    logger.warn(
      { sessionId: msg.sessionId, reason },
      'responses endpoint failed, fallback to chat/completions',
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
