import { getEnv } from '@/lib/env';
import { OpenAICompatibleProvider } from './openai-compatible';

/**
 * Groq — the fallback provider.
 *
 * Used when Featherless is unconfigured or fails. Its very low latency makes
 * it a good second attempt: a user waiting on an explanation has already spent
 * the primary provider's timeout budget.
 */
export function createGroqProvider(fetchImpl?: typeof fetch): OpenAICompatibleProvider {
  const env = getEnv();
  return new OpenAICompatibleProvider({
    id: 'groq',
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
    baseUrl: env.GROQ_BASE_URL,
    timeoutMs: env.AI_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
