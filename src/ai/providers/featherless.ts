import { getEnv } from '@/lib/env';
import { OpenAICompatibleProvider } from './openai-compatible';

/**
 * Featherless — the primary provider.
 *
 * Chosen as primary because it serves open-weight models, which keeps the
 * project's inference swappable and self-hostable rather than tied to one
 * vendor's proprietary endpoint.
 */
export function createFeatherlessProvider(fetchImpl?: typeof fetch): OpenAICompatibleProvider {
  const env = getEnv();
  return new OpenAICompatibleProvider({
    id: 'featherless',
    apiKey: env.FEATHERLESS_API_KEY,
    model: env.FEATHERLESS_MODEL,
    baseUrl: env.FEATHERLESS_BASE_URL,
    timeoutMs: env.AI_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
