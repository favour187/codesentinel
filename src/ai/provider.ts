/**
 * Provider abstraction for AI inference.
 *
 * Application code depends only on `AIProvider`. Swapping models or vendors is
 * a change to this directory and to environment variables — never to a
 * scanner, a route, or a React component.
 *
 * Both current providers speak the OpenAI chat-completions dialect, so they
 * share one transport implementation and differ only in configuration. That is
 * a fact about today's vendors rather than a constraint of the interface: a
 * provider with a different wire format simply implements `AIProvider`
 * directly.
 */

export type AIRole = 'system' | 'user';

export interface AIMessage {
  readonly role: AIRole;
  readonly content: string;
}

export interface AICompletionRequest {
  readonly messages: readonly AIMessage[];
  /** Low by default: analysis should be reproducible, not creative. */
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Ask the provider for strict JSON when the caller will parse it. */
  readonly json?: boolean;
  readonly signal?: AbortSignal;
}

export interface AICompletion {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly latencyMs: number;
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  /** False when unconfigured; the router skips it without attempting a call. */
  isAvailable(): boolean;
  complete(request: AICompletionRequest): Promise<AICompletion>;
}

/**
 * A provider call failed. `retryable` drives fallback: a bad API key should
 * move on to the next provider, and so should a timeout, but neither should
 * ever surface as a failed scan.
 */
export class AIProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
