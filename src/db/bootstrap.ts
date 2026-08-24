import { sql } from 'drizzle-orm';
import type { Database } from './index';
import { createLogger } from '@/lib/logger';

const log = createLogger('db:bootstrap');

/**
 * Idempotent schema bootstrap.
 *
 * Kept as explicit `CREATE TABLE IF NOT EXISTS` DDL (rather than only
 * drizzle-kit migration files) so that:
 *   - `npm run dev` works instantly against an empty PGlite database,
 *   - tests can spin up a fresh in-memory database in milliseconds,
 *   - production still uses versioned drizzle-kit migrations (npm run db:migrate).
 *
 * This DDL mirrors src/db/schema.ts exactly; a test asserts they stay in sync.
 */
export const BOOTSTRAP_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id integer NOT NULL,
  login text NOT NULL,
  name text,
  email text,
  avatar_url text,
  access_token_encrypted text,
  token_scopes text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_idx ON users (github_id);
CREATE INDEX IF NOT EXISTS users_login_idx ON users (login);

CREATE TABLE IF NOT EXISTS installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id integer NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL DEFAULT 'User',
  target_id integer,
  repository_selection text DEFAULT 'selected',
  permissions jsonb DEFAULT '{}'::jsonb,
  suspended_at timestamptz,
  installed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS installations_installation_id_idx ON installations (installation_id);

CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'github',
  github_id integer,
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  is_private boolean NOT NULL DEFAULT false,
  description text,
  primary_language text,
  html_url text,
  installation_id uuid REFERENCES installations(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  guardian_enabled boolean NOT NULL DEFAULT false,
  last_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_full_name_source_idx ON repositories (full_name, source);
CREATE INDEX IF NOT EXISTS repositories_owner_user_idx ON repositories (owner_user_id);

CREATE TABLE IF NOT EXISTS repository_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  fail_on_severity text NOT NULL DEFAULT 'high',
  enabled_scanners jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_on_push boolean NOT NULL DEFAULT true,
  scan_on_pull_request boolean NOT NULL DEFAULT true,
  post_pr_comments boolean NOT NULL DEFAULT true,
  create_checks boolean NOT NULL DEFAULT true,
  scan_schedule text NOT NULL DEFAULT 'daily',
  ignore_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_policies_repo_idx ON repository_policies (repository_id);

CREATE TABLE IF NOT EXISTS commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha text NOT NULL,
  message text,
  author_name text,
  author_email text,
  authored_at timestamptz,
  additions integer DEFAULT 0,
  deletions integer DEFAULT 0,
  changed_files integer DEFAULT 0,
  changed_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commits_repo_sha_idx ON commits (repository_id, sha);
CREATE INDEX IF NOT EXISTS commits_authored_at_idx ON commits (authored_at);
-- Additive patch: databases bootstrapped before commit-path tracking existed
-- keep their rows; CREATE TABLE IF NOT EXISTS alone would silently skip it.
ALTER TABLE commits ADD COLUMN IF NOT EXISTS changed_paths jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text,
  state text NOT NULL DEFAULT 'open',
  author_login text,
  head_sha text,
  base_sha text,
  head_ref text,
  base_ref text,
  risk_level text,
  risk_score real,
  risk_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  comment_external_id text,
  files_changed integer DEFAULT 0,
  additions integer DEFAULT 0,
  deletions integer DEFAULT 0,
  merged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_requests_repo_number_idx ON pull_requests (repository_id, number);

CREATE TABLE IF NOT EXISTS scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  trigger text NOT NULL DEFAULT 'manual',
  commit_sha text,
  ref text,
  pull_request_id uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  scanner_runs jsonb NOT NULL DEFAULT '[]'::jsonb,
  files_scanned integer NOT NULL DEFAULT 0,
  lines_scanned integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error text,
  base_scan_id uuid,
  check_run_id text,
  check_conclusion text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scans_repo_created_idx ON scans (repository_id, created_at);
CREATE INDEX IF NOT EXISTS scans_status_idx ON scans (status);

CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  rule_id text NOT NULL,
  scanner_id text NOT NULL,
  severity text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  title text NOT NULL,
  description text NOT NULL,
  file_path text,
  line_start integer,
  line_end integer,
  evidence text,
  confidence real NOT NULL DEFAULT 0.8,
  why_it_matters text,
  remediation text,
  "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_tests jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_explanation text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_scan_idx ON findings (scan_id);
CREATE INDEX IF NOT EXISTS findings_repo_status_idx ON findings (repository_id, status);
CREATE INDEX IF NOT EXISTS findings_fingerprint_idx ON findings (repository_id, fingerprint);
CREATE INDEX IF NOT EXISTS findings_severity_idx ON findings (severity);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id uuid REFERENCES scans(id) ON DELETE CASCADE,
  path text NOT NULL,
  language text,
  loc integer NOT NULL DEFAULT 0,
  bytes integer NOT NULL DEFAULT 0,
  imports jsonb NOT NULL DEFAULT '[]'::jsonb,
  exports jsonb NOT NULL DEFAULT '[]'::jsonb,
  kind text,
  complexity integer DEFAULT 0,
  churn integer DEFAULT 0,
  risk_score real DEFAULT 0,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_repo_path_idx ON files (repository_id, path);
CREATE INDEX IF NOT EXISTS files_scan_idx ON files (scan_id);

CREATE TABLE IF NOT EXISTS dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id uuid REFERENCES scans(id) ON DELETE CASCADE,
  ecosystem text NOT NULL DEFAULT 'npm',
  name text NOT NULL,
  version text,
  version_spec text,
  is_dev boolean NOT NULL DEFAULT false,
  is_direct boolean NOT NULL DEFAULT true,
  manifest_path text,
  vulnerabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  latest_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dependencies_repo_idx ON dependencies (repository_id);
CREATE UNIQUE INDEX IF NOT EXISTS dependencies_scan_name_idx ON dependencies (scan_id, ecosystem, name, manifest_path);

CREATE TABLE IF NOT EXISTS tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id uuid REFERENCES scans(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  framework text,
  test_count integer NOT NULL DEFAULT 0,
  covers_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_assertions boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tests_repo_idx ON tests (repository_id);
CREATE INDEX IF NOT EXISTS tests_scan_idx ON tests (scan_id);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id uuid REFERENCES scans(id) ON DELETE SET NULL,
  health real NOT NULL,
  security real NOT NULL,
  reliability real NOT NULL,
  quality real NOT NULL,
  testing real NOT NULL,
  performance real NOT NULL,
  counts jsonb NOT NULL DEFAULT '{"critical":0,"high":0,"medium":0,"low":0,"info":0}'::jsonb,
  issues_resolved integer NOT NULL DEFAULT 0,
  issues_introduced integer NOT NULL DEFAULT 0,
  debt_hours real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_repo_created_idx ON health_snapshots (repository_id, created_at);

CREATE TABLE IF NOT EXISTS fixes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  origin text NOT NULL DEFAULT 'deterministic',
  status text NOT NULL DEFAULT 'proposed',
  title text NOT NULL,
  explanation text,
  patch text,
  original_code text,
  fixed_code text,
  suggested_test text,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixes_finding_idx ON fixes (finding_id);
CREATE INDEX IF NOT EXISTS fixes_repo_status_idx ON fixes (repository_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid REFERENCES repositories(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at);

CREATE TABLE IF NOT EXISTS repository_members (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, user_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text NOT NULL,
  event text NOT NULL,
  action text,
  repository_full_name text,
  installation_id integer,
  status text NOT NULL DEFAULT 'received',
  message text,
  scan_id uuid REFERENCES scans(id) ON DELETE SET NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_delivery_idx ON webhook_deliveries (delivery_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_idx ON webhook_deliveries (repository_full_name);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  trigger text NOT NULL DEFAULT 'manual',
  commit_sha text,
  ref text,
  pull_request_number integer,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at timestamptz,
  locked_by text,
  scan_id uuid REFERENCES scans(id) ON DELETE SET NULL,
  delivery_id text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scan_jobs_status_idx ON scan_jobs (status, priority);
CREATE INDEX IF NOT EXISTS scan_jobs_repo_idx ON scan_jobs (repository_id, created_at);

CREATE TABLE IF NOT EXISTS ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid REFERENCES repositories(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES findings(id) ON DELETE SET NULL,
  task text NOT NULL,
  provider text,
  model text,
  status text NOT NULL,
  duration_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  redacted_kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
  cache_key text,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_requests_repo_created_idx ON ai_requests (repository_id, created_at);
CREATE INDEX IF NOT EXISTS ai_requests_cache_idx ON ai_requests (cache_key);
CREATE INDEX IF NOT EXISTS ai_requests_finding_idx ON ai_requests (finding_id);

CREATE TABLE IF NOT EXISTS repository_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'decision',
  title text NOT NULL,
  body text NOT NULL,
  paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repository_memory_repo_idx ON repository_memory (repository_id, kind);
`;

/** All table names, in dependency order (useful for tests / teardown). */
export const TABLE_NAMES = [
  'users',
  'installations',
  'repositories',
  'repository_policies',
  'commits',
  'pull_requests',
  'scans',
  'findings',
  'files',
  'dependencies',
  'tests',
  'health_snapshots',
  'fixes',
  'notifications',
  'repository_members',
  'webhook_deliveries',
  'scan_jobs',
  'ai_requests',
  'repository_memory',
] as const;

export async function bootstrapSchema(database: Database): Promise<void> {
  const started = Date.now();
  // pgcrypto provides gen_random_uuid() on older Postgres; PG13+ has it builtin.
  try {
    await database.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto;'));
  } catch {
    // Managed providers may forbid CREATE EXTENSION; gen_random_uuid() is
    // built in from PostgreSQL 13 onward, so this is non-fatal.
  }

  for (const statement of splitStatements(BOOTSTRAP_SQL)) {
    await database.execute(sql.raw(statement));
  }
  log.info('Schema ready', { durationMs: Date.now() - started, tables: TABLE_NAMES.length });
}

/**
 * Split DDL on semicolons at statement boundaries.
 *
 * Comment lines are stripped *before* splitting, not filtered out after. A
 * semicolon inside a `--` comment would otherwise cut the text mid-sentence
 * and hand the fragment to the server as a statement, which fails with a
 * baffling syntax error pointing at an English word.
 */
export function splitStatements(ddl: string): string[] {
  const withoutComments = ddl
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`);
}
