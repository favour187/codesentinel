import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { aiRequests } from '@/db/schema';
import { runAITask } from '@/ai/router';
import { AIProviderError } from '@/ai/provider';
import type { AICompletion, AICompletionRequest, AIProvider } from '@/ai/provider';
import { createTestDb, seedRepository } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';









const TestSchema = z.object({ answer: z.string(), confidence: z.enum(['high', 'medium', 'low']) });


class StubProvider implements AIProvider {
  readonly calls: AICompletionRequest[] = [];

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly behaviour: 'ok' | 'throw' | 'invalid-json' | 'schema-miss' | 'unavailable',
    private readonly payload: string = '{"answer":"grounded","confidence":"high"}',
  ) {}

  isAvailable(): boolean {
    return this.behaviour !== 'unavailable';
  }

  async complete(request: AICompletionRequest): Promise<AICompletion> {
    this.calls.push(request);

    if (this.behaviour === 'throw') {
      throw new AIProviderError(this.id, `${this.id} exploded`, 500, true);
    }

    const text =
      this.behaviour === 'invalid-json'
        ? 'I am afraid I cannot do that.'
        : this.behaviour === 'schema-miss'
          ? '{"answer":"missing confidence"}'
          : this.payload;

    return {
      text,
      model: this.model,
      provider: this.id,
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 5,
    };
  }
}

let db: TestDb;
let repositoryId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedRepository(db);
  repositoryId = seeded.repositoryId;
});

function request(overrides: Partial<Parameters<typeof runAITask>[0]> = {}) {
  return {
    task: 'test-task',
    schema: TestSchema,
    system: 'system rules',
    user: 'evidence block',
    repositoryId,
    ...overrides,
  } as Parameters<typeof runAITask<typeof TestSchema>>[0];
}

describe('runAITask', () => {
  it('returns validated data from the primary provider', async () => {
    const primary = new StubProvider('featherless', 'llama-primary', 'ok');
    const fallback = new StubProvider('groq', 'llama-fallback', 'ok');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toEqual({ answer: 'grounded', confidence: 'high' });
    expect(result.provider).toBe('featherless');
    expect(result.model).toBe('llama-primary');
    expect(result.cached).toBe(false);


    expect(fallback.calls).toHaveLength(0);
  });

  it('falls back to Groq when Featherless fails', async () => {
    const primary = new StubProvider('featherless', 'llama-primary', 'throw');
    const fallback = new StubProvider('groq', 'llama-fallback', 'ok');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.provider).toBe('groq');
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it('falls back when the primary returns unparseable output', async () => {
    const primary = new StubProvider('featherless', 'm1', 'invalid-json');
    const fallback = new StubProvider('groq', 'm2', 'ok');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.provider).toBe('groq');
  });

  it('falls back when the primary output fails schema validation', async () => {
    const primary = new StubProvider('featherless', 'm1', 'schema-miss');
    const fallback = new StubProvider('groq', 'm2', 'ok');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.provider).toBe('groq');
  });

  it('degrades gracefully — never throws — when every provider fails', async () => {
    const primary = new StubProvider('featherless', 'm1', 'throw');
    const fallback = new StubProvider('groq', 'm2', 'throw');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('failed');
    expect(result.message).toBeTruthy();
  });

  it('reports "unavailable" without calling out when no provider is configured', async () => {
    const unconfigured = new StubProvider('featherless', 'm1', 'unavailable');

    const result = await runAITask(request(), { providers: [unconfigured] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('unavailable');
    expect(unconfigured.calls).toHaveLength(0);


    const rows = await db.select().from(aiRequests);
    expect(rows).toHaveLength(0);
  });

  it('distinguishes malformed output ("invalid") from an outage ("failed")', async () => {
    const primary = new StubProvider('featherless', 'm1', 'invalid-json');
    const fallback = new StubProvider('groq', 'm2', 'schema-miss');

    const result = await runAITask(request(), { providers: [primary, fallback] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid');
  });

  it('never sends unredacted secrets to a provider', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');
    const secret = 'const key = "sk_live_abcdefghijklmnopqrstuvwx";';

    await runAITask(request({ user: `here is the code\n${secret}` }), { providers: [primary] });

    const sent = primary.calls[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(sent).not.toContain('sk_live_abcdefghijklmnopqrstuvwx');
    expect(sent).toContain('here is the code');
  });

  it('records the redaction kinds — but never the prompt — in the ledger', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');
    await runAITask(request({ user: 'AKIAIOSFODNN7EXAMPLE is the key' }), { providers: [primary] });

    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.repositoryId, repositoryId));
    expect(row).toBeDefined();
    expect(row?.redactedKinds.length).toBeGreaterThan(0);


    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('writes an ok ledger entry with provider, model, duration and evidence', async () => {
    const primary = new StubProvider('featherless', 'llama-primary', 'ok');

    await runAITask(request({ evidenceSources: ['file:src/db.ts', 'finding:abc'] }), { providers: [primary] });

    const [row] = await db.select().from(aiRequests);
    expect(row?.status).toBe('ok');
    expect(row?.provider).toBe('featherless');
    expect(row?.model).toBe('llama-primary');
    expect(row?.task).toBe('test-task');
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.evidenceSources).toEqual(['file:src/db.ts', 'finding:abc']);
    expect(row?.promptTokens).toBe(100);
  });

  it('records the failed attempt when it falls back, proving the fallback happened', async () => {
    const primary = new StubProvider('featherless', 'm1', 'throw');
    const fallback = new StubProvider('groq', 'm2', 'ok');

    await runAITask(request(), { providers: [primary, fallback] });

    const [row] = await db.select().from(aiRequests);
    expect(row?.provider).toBe('groq');
    expect(row?.attempts).toHaveLength(1);
    expect(row?.attempts[0]?.provider).toBe('featherless');
    expect(row?.attempts[0]?.error).toContain('exploded');
  });

  it('writes a failure entry when everything fails', async () => {
    const primary = new StubProvider('featherless', 'm1', 'throw');

    await runAITask(request(), { providers: [primary] });

    const [row] = await db.select().from(aiRequests);
    expect(row?.status).toBe('failed');
    expect(row?.provider).toBeNull();
    expect(row?.error).toContain('featherless');
  });

  it('serves an identical repeat request from cache without calling a provider', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');

    const first = await runAITask(request(), { providers: [primary] });
    expect(first.ok).toBe(true);
    expect(primary.calls).toHaveLength(1);

    const second = await runAITask(request(), { providers: [primary] });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected success');
    expect(second.cached).toBe(true);


    expect(primary.calls).toHaveLength(1);
  });

  it('bypasses the cache when noCache is set, for an explicit regenerate', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');

    await runAITask(request(), { providers: [primary] });
    await runAITask(request({ noCache: true }), { providers: [primary] });

    expect(primary.calls).toHaveLength(2);
  });

  it('treats different evidence as a different cache entry', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');

    await runAITask(request({ user: 'evidence A' }), { providers: [primary] });
    await runAITask(request({ user: 'evidence B' }), { providers: [primary] });

    expect(primary.calls).toHaveLength(2);
  });

  it('truncates oversized evidence to the configured context budget', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i} of source code`).join('\n');

    await runAITask(request({ user: huge }), { providers: [primary] });

    const sent = primary.calls[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(sent.length).toBeLessThan(huge.length);
    expect(sent).toContain('truncated');
  });

  it('passes the system prompt through unmodified', async () => {
    const primary = new StubProvider('featherless', 'm1', 'ok');
    await runAITask(request({ system: 'DO NOT INVENT PATHS' }), { providers: [primary] });

    const system = primary.calls[0]?.messages.find((m) => m.role === 'system')?.content;
    expect(system).toBe('DO NOT INVENT PATHS');
  });
});
