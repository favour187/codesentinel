import { AIProviderError } from '../provider';
import type { AICompletion, AICompletionRequest, AIProvider } from '../provider';

/**
 * Shared transport for OpenAI-compatible chat-completions endpoints.
 *
 * Featherless and Groq both implement this dialect, so the wire logic —
 * timeouts, error classification, usage extraction — lives here once. Each
 * concrete provider supplies only its identity and configuration.
 */

export interface OpenAICompatibleConfig {
  readonly id: string;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Injectable for tests; never reaches the network in the suite. */
  readonly fetchImpl?: typeof fetch;
}

interface ChatChoice {
  message?: { content?: unknown };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: { message?: unknown };
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const SKIP_MODEL = /whisper|tts|guard|orpheus|compound/i;

async function pickAccessibleChatModel(
  fetchImpl: typeof fetch,
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers,
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (payload.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    const preferred = [
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ];
    for (const id of preferred) {
      if (ids.includes(id)) return id;
    }
    return ids.find((id) => !SKIP_MODEL.test(id)) ?? null;
  } catch {
    return null;
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  model: string;
  private readonly config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.id = config.id;
    this.model = config.model;
  }

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async complete(request: AICompletionRequest): Promise<AICompletion> {
    if (!this.isAvailable()) {
      throw new AIProviderError(this.id, `${this.id} is not configured`, undefined, true);
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const started = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const authHeaders = {
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CodeSentinel',
      };

      const post = async (useJson: boolean, tokenField: 'max_tokens' | 'max_completion_tokens') => {
        return fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: authHeaders,
          cache: 'no-store',
          body: JSON.stringify({
            model: this.model,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            temperature: request.temperature ?? 0.1,
            [tokenField]: request.maxTokens ?? 1200,
            ...(useJson ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
      };

      let useJson = Boolean(request.json);
      let tokenField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
      let response = await post(useJson, tokenField);
      let raw = await response.text();

      if (!response.ok && response.status === 404) {
        const fallback = await pickAccessibleChatModel(
          fetchImpl,
          this.config.baseUrl,
          authHeaders,
          controller.signal,
        );
        if (fallback && fallback !== this.model) {
          this.model = fallback;
          response = await post(useJson, tokenField);
          raw = await response.text();
        }
      }

      if (!response.ok && response.status === 400) {
        const hint = `${extractError(raw)} ${raw}`.toLowerCase();
        if (useJson && /response_format|json_object|json mode/i.test(hint)) {
          useJson = false;
          response = await post(useJson, tokenField);
          raw = await response.text();
        } else if (tokenField === 'max_tokens' && /max_completion_tokens|max_tokens/i.test(hint)) {
          tokenField = 'max_completion_tokens';
          response = await post(useJson, tokenField);
          raw = await response.text();
        }
      }

      if (!response.ok) {
        const permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
        throw new AIProviderError(
          this.id,
          `${this.id} responded ${response.status}: ${extractError(raw).slice(0, 300)}`,
          response.status,
          !permanent,
        );
      }

      let parsed: ChatResponse;
      try {
        parsed = JSON.parse(raw) as ChatResponse;
      } catch {
        throw new AIProviderError(this.id, `${this.id} returned a non-JSON body`, response.status, true);
      }

      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new AIProviderError(this.id, `${this.id} returned an empty completion`, response.status, true);
      }

      return {
        text: content,
        model: this.model,
        provider: this.id,
        promptTokens: numberOrNull(parsed.usage?.prompt_tokens),
        completionTokens: numberOrNull(parsed.usage?.completion_tokens),
        latencyMs: Date.now() - started,
      };
    } catch (error: unknown) {
      if (error instanceof AIProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AIProviderError(this.id, `${this.id} timed out after ${this.config.timeoutMs}ms`, 408, true);
      }
      throw new AIProviderError(this.id, `${this.id} request failed: ${(error as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function extractError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as ChatResponse;
    const message = parsed.error?.message;
    if (typeof message === 'string') return message;
  } catch {
    /* fall through */
  }
  return raw || 'no response body';
}
