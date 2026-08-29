import { getEnv } from '@/lib/env';

export interface ProviderProbe {
  id: 'groq' | 'featherless';
  configured: boolean;

  fingerprint: string | null;
  looksLikeGroqKey: boolean;
  ok: boolean;
  status: number | null;
  error: string | null;
}

function fingerprintKey(key: string): string {
  if (key.length < 8) return `${key.slice(0, 3)}… (${key.length} chars)`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}

async function probe(
  id: 'groq' | 'featherless',
  apiKey: string,
  modelsUrl: string,
): Promise<ProviderProbe> {
  const configured = apiKey.length > 0;
  if (!configured) {
    return {
      id,
      configured: false,
      fingerprint: null,
      looksLikeGroqKey: false,
      ok: false,
      status: null,
      error: null,
    };
  }

  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'CodeSentinel' },
      cache: 'no-store',
    });
    const raw = await response.text();
    let error: string | null = null;
    if (!response.ok) {
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        error = parsed.error?.message ?? raw.slice(0, 160);
      } catch {
        error = raw.slice(0, 160) || `HTTP ${response.status}`;
      }
    }
    return {
      id,
      configured: true,
      fingerprint: fingerprintKey(apiKey),
      looksLikeGroqKey: apiKey.startsWith('gsk_'),
      ok: response.ok,
      status: response.status,
      error,
    };
  } catch (err) {
    return {
      id,
      configured: true,
      fingerprint: fingerprintKey(apiKey),
      looksLikeGroqKey: apiKey.startsWith('gsk_'),
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : 'network error',
    };
  }
}

export async function probeAIProviders(): Promise<{ groq: ProviderProbe; featherless: ProviderProbe }> {
  const env = getEnv();
  const [groq, featherless] = await Promise.all([
    probe('groq', env.GROQ_API_KEY, `${env.GROQ_BASE_URL.replace(/\/$/, '')}/models`),
    probe(
      'featherless',
      env.FEATHERLESS_API_KEY,
      `${env.FEATHERLESS_BASE_URL.replace(/\/$/, '')}/models`,
    ),
  ]);
  return { groq, featherless };
}
