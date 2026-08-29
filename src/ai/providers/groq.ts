import { getEnv } from '@/lib/env';
import { OpenAICompatibleProvider } from './openai-compatible';








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
