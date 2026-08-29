













export type AIRole = 'system' | 'user';

export interface AIMessage {
  readonly role: AIRole;
  readonly content: string;
}

export interface AICompletionRequest {
  readonly messages: readonly AIMessage[];

  readonly temperature?: number;
  readonly maxTokens?: number;

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

  isAvailable(): boolean;
  complete(request: AICompletionRequest): Promise<AICompletion>;
}






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
