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

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly model: string;
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

    /*
     * Two abort sources: our own timeout and the caller's signal (e.g. the
     * user navigated away). Without the timeout a hung provider would hold a
     * request open until the platform kills it.
     */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: request.temperature ?? 0.1,
          max_tokens: request.maxTokens ?? 1200,
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      const raw = await response.text();

      if (!response.ok) {
        /*
         * 4xx other than 408/429 means the request itself is wrong (bad key,
         * unknown model, oversized prompt). Retrying the SAME provider is
         * pointless, but the router should still fall through to the next one.
         */
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
        model: this.config.model,
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

/** Pull a useful message out of an error body without assuming its shape. */
function extractError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as ChatResponse;
    const message = parsed.error?.message;
    if (typeof message === 'string') return message;
  } catch {
    /* fall through to the raw body */
  }
  return raw || 'no response body';
}
