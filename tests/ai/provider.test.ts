import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '@/ai/providers/openai-compatible';
import { createFeatherlessProvider } from '@/ai/providers/featherless';
import { createGroqProvider } from '@/ai/providers/groq';
import { AIProviderError } from '@/ai/provider';
import { resetEnvCache } from '@/lib/env';

/**
 * Provider abstraction tests.
 *
 * Every call is served by an injected fetch. Nothing in this suite touches the
 * network, and the suite must pass with no API keys configured — which is also
 * the state a contributor's machine is in.
 */

function chatResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeProvider(fetchImpl: typeof fetch, overrides: Partial<{ apiKey: string; timeoutMs: number }> = {}) {
  return new OpenAICompatibleProvider({
    id: 'test-provider',
    apiKey: overrides.apiKey ?? 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    timeoutMs: overrides.timeoutMs ?? 5000,
    fetchImpl,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('reports unavailable when no API key is configured', () => {
    const provider = makeProvider(vi.fn() as unknown as typeof fetch, { apiKey: '' });
    expect(provider.isAvailable()).toBe(false);
  });

  it('sends a well-formed chat completion request', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"ok":true}')) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);

    await provider.complete({
      messages: [
        { role: 'system', content: 'be precise' },
        { role: 'user', content: 'evidence here' },
      ],
      json: true,
      maxTokens: 500,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(500);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'evidence here' },
    ]);
  });

  it('returns the completion text with token usage', async () => {
    const fetchImpl = vi.fn(async () =>
      chatResponse('{"answer":"yes"}', { prompt_tokens: 120, completion_tokens: 30 }),
    ) as unknown as typeof fetch;

    const result = await makeProvider(fetchImpl).complete({ messages: [{ role: 'user', content: 'q' }] });

    expect(result.text).toBe('{"answer":"yes"}');
    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
    expect(result.promptTokens).toBe(120);
    expect(result.completionTokens).toBe(30);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tolerates a response with no usage block', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{}')) as unknown as typeof fetch;
    const result = await makeProvider(fetchImpl).complete({ messages: [{ role: 'user', content: 'q' }] });

    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
  });

  it('marks a 401 as non-retryable so the router falls through instead of retrying', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    ) as unknown as typeof fetch;

    const error = await makeProvider(fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIProviderError);
    const typed = error as AIProviderError;
    expect(typed.status).toBe(401);
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain('bad key');
  });

  it('marks 429 and 5xx as retryable', async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
      const error = (await makeProvider(fetchImpl)
        .complete({ messages: [{ role: 'user', content: 'q' }] })
        .catch((e: unknown) => e)) as AIProviderError;

      expect(error.retryable, `status ${status} should be retryable`).toBe(true);
    }
  });

  it('rejects an empty completion rather than returning blank content', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('   ')) as unknown as typeof fetch;
    const error = await makeProvider(fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as Error).message).toContain('empty completion');
  });

  it('rejects a non-JSON body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>gateway error</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    const error = await makeProvider(fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('non-JSON');
  });

  it('times out a hung provider', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const error = (await makeProvider(fetchImpl, { timeoutMs: 20 })
      .complete({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as AIProviderError;

    expect(error).toBeInstanceOf(AIProviderError);
    expect(error.message).toContain('timed out');
    expect(error.status).toBe(408);
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const promise = makeProvider(fetchImpl).complete({
      messages: [{ role: 'user', content: 'q' }],
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(AIProviderError);
  });

  it('refuses to call out when unconfigured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      makeProvider(fetchImpl, { apiKey: '' }).complete({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toBeInstanceOf(AIProviderError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('provider factories', () => {
  it('build Featherless as the primary provider from environment configuration', () => {
    process.env.FEATHERLESS_API_KEY = 'fk-test';
    resetEnvCache();

    const provider = createFeatherlessProvider();
    expect(provider.id).toBe('featherless');
    expect(provider.isAvailable()).toBe(true);
    expect(provider.model.length).toBeGreaterThan(0);

    delete process.env.FEATHERLESS_API_KEY;
    resetEnvCache();
  });

  it('build Groq as the fallback provider', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    resetEnvCache();

    const provider = createGroqProvider();
    expect(provider.id).toBe('groq');
    expect(provider.isAvailable()).toBe(true);

    delete process.env.GROQ_API_KEY;
    resetEnvCache();
  });

  it('report unavailable when their keys are absent', () => {
    resetEnvCache();
    expect(createFeatherlessProvider().isAvailable()).toBe(false);
    expect(createGroqProvider().isAvailable()).toBe(false);
  });
});
