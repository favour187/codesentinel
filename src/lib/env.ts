import { z } from 'zod';

/**
 * Centralised, validated environment access.
 *
 * Rules:
 *  - Nothing else in the codebase reads `process.env` directly (except this file
 *    and next.config.ts), so misconfiguration surfaces in exactly one place.
 *  - Optional integrations (GitHub App, LLM) are *feature-detected* rather than
 *    required, so the app boots and the deterministic scanners still work.
 */

const bool = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().optional().default(''),

  SESSION_SECRET: z.string().min(16).default('dev-only-insecure-session-secret-change-me-please-32b'),
  ENCRYPTION_KEY: z.string().optional().default(''),

  GITHUB_CLIENT_ID: z.string().optional().default(''),
  GITHUB_CLIENT_SECRET: z.string().optional().default(''),

  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_APP_SLUG: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),

  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'none']).default('none'),
  LLM_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_BASE_URL: z.string().optional().default(''),

  SEMGREP_PATH: z.string().optional().default(''),
  SCAN_MAX_FILE_BYTES: z.coerce.number().int().positive().default(1_000_000),

  /** Shared secret authorising the scheduled scan-queue drain endpoint. */
  CRON_SECRET: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset cache — test-only helper. */
export function resetEnvCache(): void {
  cached = null;
}

/* -------------------------------------------------------------------------- */
/* Feature detection                                                          */
/* -------------------------------------------------------------------------- */

export interface FeatureFlags {
  /** A real Postgres server is configured (vs embedded PGlite). */
  postgres: boolean;
  /** GitHub OAuth sign-in is configured. */
  githubOAuth: boolean;
  /** GitHub App (webhooks / checks / PR comments) is configured. */
  githubApp: boolean;
  /** Webhook signature verification possible. */
  webhooks: boolean;
  /** LLM-backed explanations available. */
  llm: boolean;
  /** Tokens can be encrypted at rest with a dedicated key. */
  encryptionKey: boolean;
}

export function getFeatures(env: Env = getEnv()): FeatureFlags {
  return {
    postgres: env.DATABASE_URL.trim().length > 0,
    githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    githubApp: Boolean(env.GITHUB_APP_ID && (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH)),
    webhooks: Boolean(env.GITHUB_WEBHOOK_SECRET),
    llm: env.LLM_PROVIDER !== 'none' && Boolean(env.LLM_API_KEY),
    encryptionKey: env.ENCRYPTION_KEY.trim().length > 0,
  };
}

export const isProduction = (): boolean => getEnv().NODE_ENV === 'production';
export const isTest = (): boolean => getEnv().NODE_ENV === 'test';
export { bool };
