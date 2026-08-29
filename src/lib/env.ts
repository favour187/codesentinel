import { z } from 'zod';











const bool = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};


export function sanitizeSecret(raw: string): string {
  let value = raw.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/^bearer\s+/i, '').trim();
}

const secret = z.string().optional().default('').transform((v) => sanitizeSecret(v));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().optional().default(''),

  DB_POOL_MAX: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),

  SESSION_SECRET: z.string().min(16).default('dev-only-insecure-session-secret-change-me-please-32b'),
  ENCRYPTION_KEY: z.string().optional().default(''),

  GITHUB_CLIENT_ID: secret,
  GITHUB_CLIENT_SECRET: secret,

  GITHUB_APP_ID: secret,
  GITHUB_APP_SLUG: secret,
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: secret,





  FEATHERLESS_API_KEY: secret,
  FEATHERLESS_MODEL: z.string().default('meta-llama/Meta-Llama-3.1-8B-Instruct'),
  FEATHERLESS_BASE_URL: z.string().url().default('https://api.featherless.ai/v1'),

  GROQ_API_KEY: secret,

  GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),


  AI_MAX_CONTEXT_CHARS: z.coerce.number().int().positive().default(24_000),

  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  AI_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(86_400),

  SEMGREP_PATH: z.string().optional().default(''),
  SCAN_MAX_FILE_BYTES: z.coerce.number().int().positive().default(1_000_000),


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


export function resetEnvCache(): void {
  cached = null;
}





export interface FeatureFlags {

  postgres: boolean;

  githubOAuth: boolean;

  githubApp: boolean;

  webhooks: boolean;

  llm: boolean;

  featherless: boolean;

  groq: boolean;

  encryptionKey: boolean;
}

export function getFeatures(env: Env = getEnv()): FeatureFlags {
  return {
    postgres: env.DATABASE_URL.trim().length > 0,
    githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    githubApp: Boolean(env.GITHUB_APP_ID && (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH)),
    webhooks: Boolean(env.GITHUB_WEBHOOK_SECRET),
    llm: Boolean(env.FEATHERLESS_API_KEY || env.GROQ_API_KEY),
    featherless: Boolean(env.FEATHERLESS_API_KEY),
    groq: Boolean(env.GROQ_API_KEY),
    encryptionKey: env.ENCRYPTION_KEY.trim().length > 0,
  };
}

export const isProduction = (): boolean => getEnv().NODE_ENV === 'production';
export const isTest = (): boolean => getEnv().NODE_ENV === 'test';
export { bool };
