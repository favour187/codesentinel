import { createHash } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb } from '@/db';
import { aiRequests } from '@/db/schema';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { AIProviderError } from './provider';
import type { AIProvider } from './provider';
import { createFeatherlessProvider } from './providers/featherless';
import { createGroqProvider } from './providers/groq';
import { sanitizeRepositoryContent } from './redaction';
















const log = createLogger('ai:router');

export interface AITaskRequest<T extends z.ZodTypeAny> {
  readonly task: string;
  readonly schema: T;

  readonly system: string;

  readonly user: string;
  readonly repositoryId?: string | null;
  readonly findingId?: string | null;

  readonly evidenceSources?: readonly string[];
  readonly maxTokens?: number;
  readonly temperature?: number;

  readonly noCache?: boolean;
  readonly signal?: AbortSignal;
}

export type AIResult<T> =
  | { readonly ok: true; readonly data: T; readonly provider: string; readonly model: string; readonly cached: boolean }
  | { readonly ok: false; readonly reason: 'unavailable' | 'failed' | 'invalid'; readonly message: string };


export interface RouterOptions {
  readonly providers?: readonly AIProvider[];
}

export function defaultProviders(fetchImpl?: typeof fetch): AIProvider[] {
  return [createFeatherlessProvider(fetchImpl), createGroqProvider(fetchImpl)];
}

export function isAIConfigured(providers?: readonly AIProvider[]): boolean {
  return (providers ?? defaultProviders()).some((p) => p.isAvailable());
}







export async function runAITask<T extends z.ZodTypeAny>(
  request: AITaskRequest<T>,
  options: RouterOptions = {},
): Promise<AIResult<z.infer<T>>> {
  const env = getEnv();
  const providers = options.providers ?? defaultProviders();
  const available = providers.filter((p) => p.isAvailable());

  if (available.length === 0) {
    log.debug('AI task skipped: no provider configured', { task: request.task });

    return { ok: false, reason: 'unavailable', message: 'No AI provider is configured.' };
  }





  const truncated = truncate(request.user, env.AI_MAX_CONTEXT_CHARS);
  const sanitized = sanitizeRepositoryContent(truncated);
  const evidenceSources = [...(request.evidenceSources ?? [])];

  const cacheKey = hashKey([
    request.task,
    available[0]?.model ?? '',
    request.system,
    sanitized.text,
  ]);

  if (!request.noCache && env.AI_CACHE_TTL_SECONDS > 0) {
    const hit = await readCache(cacheKey, env.AI_CACHE_TTL_SECONDS);
    if (hit) {
      const parsed = request.schema.safeParse(hit.response);
      if (parsed.success) {
        log.debug('AI cache hit', { task: request.task, cacheKey });
        return {
          ok: true,
          data: parsed.data as z.infer<T>,
          provider: hit.provider ?? 'cache',
          model: hit.model ?? '',
          cached: true,
        };
      }


    }
  }

  const attempts: Array<{ provider: string; error: string }> = [];
  const started = Date.now();

  for (const provider of available) {
    try {
      const completion = await provider.complete({
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: sanitized.text },
        ],
        temperature: request.temperature ?? 0.1,
        maxTokens: request.maxTokens ?? 1200,
        json: true,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const parsedJson = parseJsonLoosely(completion.text);
      if (parsedJson === undefined) {
        attempts.push({ provider: provider.id, error: 'response was not valid JSON' });
        continue;
      }

      const validated = request.schema.safeParse(parsedJson);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        attempts.push({
          provider: provider.id,
          error: `schema validation failed: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
        });
        continue;
      }

      await writeLog({
        repositoryId: request.repositoryId ?? null,
        findingId: request.findingId ?? null,
        task: request.task,
        provider: provider.id,
        model: completion.model,
        status: 'ok',
        durationMs: Date.now() - started,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        attempts,
        evidenceSources,
        redactedKinds: [...sanitized.redacted],
        cacheKey,
        response: validated.data as Record<string, unknown>,
        error: null,
      });

      log.info('AI task complete', {
        task: request.task,
        provider: provider.id,
        model: completion.model,
        durationMs: completion.latencyMs,
        fellBackFrom: attempts.length,
      });

      return {
        ok: true,
        data: validated.data as z.infer<T>,
        provider: provider.id,
        model: completion.model,
        cached: false,
      };
    } catch (error: unknown) {
      const message =
        error instanceof AIProviderError ? error.message : `${provider.id}: ${(error as Error).message}`;
      attempts.push({ provider: provider.id, error: message.slice(0, 500) });
      log.warn('AI provider failed, trying next', { task: request.task, provider: provider.id, message });
    }
  }






  const invalidOnly = attempts.every((a) => /schema validation failed|not valid JSON/.test(a.error));
  const reason = invalidOnly && attempts.length > 0 ? 'invalid' : 'failed';

  await writeLog({
    repositoryId: request.repositoryId ?? null,
    findingId: request.findingId ?? null,
    task: request.task,
    provider: null,
    model: null,
    status: 'failed',
    durationMs: Date.now() - started,
    promptTokens: null,
    completionTokens: null,
    attempts,
    evidenceSources,
    redactedKinds: [...sanitized.redacted],
    cacheKey,
    response: null,
    error: attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ').slice(0, 2000),
  });

  log.error('AI task failed on every provider', { task: request.task, attempts: attempts.length });

  const detail = attempts
    .map((a) => a.error.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 180))
    .join(' · ');

  return {
    ok: false,
    reason,
    message:
      reason === 'invalid'
        ? 'The AI response did not match the expected format.'
        : detail
          ? `AI request failed: ${detail}`
          : 'No AI provider could be reached.',
  };
}












export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const lastNewline = clipped.lastIndexOf('\n');
  const body = lastNewline > limit * 0.5 ? clipped.slice(0, lastNewline) : clipped;
  return `${body}\n\n[... evidence truncated to fit the context budget ...]`;
}








export function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hashKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

async function readCache(
  cacheKey: string,
  ttlSeconds: number,
): Promise<{ response: unknown; provider: string | null; model: string | null } | null> {
  try {
    const db = await getDb();
    const cutoff = new Date(Date.now() - ttlSeconds * 1000);
    const rows = await db
      .select({ response: aiRequests.response, provider: aiRequests.provider, model: aiRequests.model })
      .from(aiRequests)
      .where(and(eq(aiRequests.cacheKey, cacheKey), eq(aiRequests.status, 'ok'), gte(aiRequests.createdAt, cutoff)))
      .orderBy(desc(aiRequests.createdAt))
      .limit(1);

    const row = rows[0];
    return row?.response ? { response: row.response, provider: row.provider, model: row.model } : null;
  } catch (error: unknown) {

    log.warn('AI cache read failed', { message: (error as Error).message });
    return null;
  }
}

type LogRow = typeof aiRequests.$inferInsert;

async function writeLog(row: LogRow): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(aiRequests).values(row);
  } catch (error: unknown) {

    log.warn('AI activity log write failed', { message: (error as Error).message });
  }
}
