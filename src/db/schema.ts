import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * CodeSentinel database schema.
 *
 * Design notes:
 *  - Normalized, but deliberately not over-engineered: 14 tables covering the
 *    full product surface.
 *  - Every scan-derived row hangs off `scans`, so a scan is the unit of
 *    reproducibility and can be re-run/compared.
 *  - `source` columns distinguish REAL repository analysis from DEMO fixture
 *    analysis so demo data can never masquerade as production scan data.
 *  - Credentials are stored encrypted (see lib/crypto.ts); columns are named
 *    `*Encrypted` to make plaintext storage an obvious code smell in review.
 */

/* -------------------------------------------------------------------------- */
/* Shared enum-ish unions (kept as text + CHECK-free for portability)         */
/* -------------------------------------------------------------------------- */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'security',
  'bugs',
  'quality',
  'dependencies',
  'performance',
  'reliability',
  'secrets',
  'architecture',
  'infrastructure',
  'testing',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SCAN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/**
 * Finding lifecycle.
 *  - open           present in the latest scan of the tracked branch
 *  - proposed       observed on a pull request head, i.e. on a change that has
 *                   not been merged. Kept out of every repository-level `open`
 *                   query on purpose: a proposed branch must never alter the
 *                   tracked branch's health score or finding list. The owning
 *                   scan row carries the `pull_request_id`, so these rows are
 *                   still fully attributable (and addressable by the fix engine).
 *  - superseded     still reproduces, but a newer scan owns the live row
 *  - resolved       no longer reproduces (genuinely fixed)
 *  - ignored        deliberately accepted by a maintainer
 *  - false_positive triaged as incorrect; feeds rule tuning
 */
export const FINDING_STATUSES = [
  'open',
  'proposed',
  'superseded',
  'resolved',
  'ignored',
  'false_positive',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Distinguishes real repository analysis from the bundled demo fixture. */
export const SOURCES = ['github', 'demo'] as const;
export type RepoSource = (typeof SOURCES)[number];

/** Lifecycle of a received webhook delivery. */
export const WEBHOOK_STATUSES = ['received', 'ignored', 'processed', 'failed'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

/** Lifecycle of a queued scan job. */
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Kinds of fact a team can record in repository memory. Human-authored only. */
export const MEMORY_KINDS = ['decision', 'exception', 'accepted_risk', 'policy', 'convention'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Outcome of an AI request, for the activity log. */
export const AI_REQUEST_STATUSES = ['ok', 'failed', 'unavailable', 'cached'] as const;
export type AIRequestStatus = (typeof AI_REQUEST_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Digital twin unions (Phase 5)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Symbol kinds the extensible parser layer can emit.
 *
 * Deliberately small and language-neutral: every supported language maps its
 * own concepts onto these, so a consumer never has to branch on language.
 */
export const SYMBOL_KINDS = [
  'function',
  'class',
  'method',
  'interface',
  'type',
  'variable',
  'route',
  'test',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/**
 * Relationship types in the codebase graph.
 *
 * Only relationships that can be derived from static evidence are ever
 * written. `calls` in particular is emitted only where a call expression
 * resolves to a symbol exported by a file this module actually imports —
 * an unresolved call is dropped rather than guessed at.
 */
export const EDGE_TYPES = [
  'imports',
  'calls',
  'depends_on',
  'tests',
  'exposes_api',
  'uses_database',
  'contains_finding',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** How confident the extractor is that an edge is real. */
export const EDGE_CONFIDENCE = ['certain', 'probable'] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCE)[number];

/**
 * Lifecycle of a generated test.
 *
 * `passed` is reachable ONLY by actually executing the test. Generation puts a
 * test in `generated`; anything not executed stays `not_run`. Nothing in the
 * codebase is permitted to write `passed` from a model response.
 */
export const GENERATED_TEST_STATUSES = ['generated', 'running', 'passed', 'failed', 'not_run'] as const;
export type GeneratedTestStatus = (typeof GENERATED_TEST_STATUSES)[number];

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/* -------------------------------------------------------------------------- */
/* Users & auth                                                               */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: integer('github_id').notNull(),
    login: text('login').notNull(),
    name: text('name'),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    /** AES-256-GCM encrypted OAuth access token. Never plaintext. */
    accessTokenEncrypted: text('access_token_encrypted'),
    tokenScopes: text('token_scopes'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_github_id_idx').on(t.githubId), index('users_login_idx').on(t.login)],
);

/** GitHub App installations — the bridge to webhooks, Checks and PR comments. */
export const installations = pgTable(
  'installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: integer('installation_id').notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull().default('User'),
    targetId: integer('target_id'),
    repositorySelection: text('repository_selection').default('selected'),
    permissions: jsonb('permissions').$type<Record<string, string>>().default({}),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    installedByUserId: uuid('installed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('installations_installation_id_idx').on(t.installationId)],
);

/* -------------------------------------------------------------------------- */
/* Repositories                                                               */
/* -------------------------------------------------------------------------- */

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'github' for real repos, 'demo' for the bundled vulnerable fixture. */
    source: text('source').$type<RepoSource>().notNull().default('github'),
    githubId: integer('github_id'),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    isPrivate: boolean('is_private').notNull().default(false),
    description: text('description'),
    primaryLanguage: text('primary_language'),
    htmlUrl: text('html_url'),
    installationId: uuid('installation_id').references(() => installations.id, { onDelete: 'set null' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Guardian automation toggle. */
    guardianEnabled: boolean('guardian_enabled').notNull().default(false),
    lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('repositories_full_name_source_idx').on(t.fullName, t.source),
    index('repositories_owner_user_idx').on(t.ownerUserId),
  ],
);

/** Per-repository guardian policy: thresholds, enabled scanners, automation. */
export const repositoryPolicies = pgTable(
  'repository_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Fail a GitHub Check at/above this severity. */
    failOnSeverity: text('fail_on_severity').$type<Severity>().notNull().default('high'),
    /** Scanner ids to run; empty array = all registered scanners. */
    enabledScanners: jsonb('enabled_scanners').$type<string[]>().notNull().default([]),
    scanOnPush: boolean('scan_on_push').notNull().default(true),
    scanOnPullRequest: boolean('scan_on_pull_request').notNull().default(true),
    postPrComments: boolean('post_pr_comments').notNull().default(true),
    createChecks: boolean('create_checks').notNull().default(true),
    /** Cron-ish schedule for periodic scans, e.g. 'daily' | 'weekly' | 'off'. */
    scanSchedule: text('scan_schedule').notNull().default('daily'),
    ignorePaths: jsonb('ignore_paths').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('repository_policies_repo_idx').on(t.repositoryId)],
);

/* -------------------------------------------------------------------------- */
/* Git objects                                                                */
/* -------------------------------------------------------------------------- */

export const commits = pgTable(
  'commits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    message: text('message'),
    authorName: text('author_name'),
    authorEmail: text('author_email'),
    authoredAt: timestamp('authored_at', { withTimezone: true }),
    additions: integer('additions').default(0),
    deletions: integer('deletions').default(0),
    changedFiles: integer('changed_files').default(0),
    /**
     * Paths touched by this commit, capped per commit.
     *
     * The count above answers "how big was this change"; archaeology needs
     * "which file", so the paths are stored too. Capped because a lockfile
     * refresh or a formatting sweep can touch thousands of files and we only
     * need enough to attribute history to a file under review.
     */
    changedPaths: jsonb('changed_paths').$type<string[]>().notNull().default([]),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('commits_repo_sha_idx').on(t.repositoryId, t.sha),
    index('commits_authored_at_idx').on(t.authoredAt),
  ],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title'),
    state: text('state').notNull().default('open'),
    authorLogin: text('author_login'),
    headSha: text('head_sha'),
    baseSha: text('base_sha'),
    headRef: text('head_ref'),
    baseRef: text('base_ref'),
    /** Deterministic risk assessment produced by the blast-radius engine. */
    riskLevel: text('risk_level').$type<Severity>(),
    riskScore: real('risk_score'),
    /** Explainable breakdown behind riskScore — never an opaque number in the UI. */
    riskFactors: jsonb('risk_factors').$type<Array<{ id: string; label: string; points: number; detail: string }>>()
      .notNull()
      .default([]),
    /**
     * GitHub id of the guardian's sticky review comment. Stored so repeated
     * scans EDIT one comment instead of spamming the pull request.
     */
    commentExternalId: text('comment_external_id'),
    filesChanged: integer('files_changed').default(0),
    additions: integer('additions').default(0),
    deletions: integer('deletions').default(0),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('pull_requests_repo_number_idx').on(t.repositoryId, t.number)],
);

/* -------------------------------------------------------------------------- */
/* Scans & findings                                                           */
/* -------------------------------------------------------------------------- */

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    status: text('status').$type<ScanStatus>().notNull().default('queued'),
    /** What triggered it: manual | push | pull_request | schedule | webhook. */
    trigger: text('trigger').notNull().default('manual'),
    commitSha: text('commit_sha'),
    ref: text('ref'),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id, { onDelete: 'set null' }),
    /** Scanner ids that actually executed, with per-scanner timing/status. */
    scannerRuns: jsonb('scanner_runs').$type<
      Array<{ id: string; status: 'ok' | 'error' | 'skipped'; durationMs: number; findings: number; message?: string }>
    >().notNull().default([]),
    filesScanned: integer('files_scanned').notNull().default(0),
    linesScanned: integer('lines_scanned').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
    /**
     * The scan this one was diffed against (the base branch scan for a PR).
     * Null for plain branch scans. Makes "new vs pre-existing" reproducible.
     */
    baseScanId: uuid('base_scan_id'),
    /** GitHub Check Run id, so a re-scan updates the existing check. */
    checkRunId: text('check_run_id'),
    /** success | failure | neutral | action_required — mirrors the posted check. */
    checkConclusion: text('check_conclusion'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('scans_repo_created_idx').on(t.repositoryId, t.createdAt),
    index('scans_status_idx').on(t.status),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /**
     * Stable identity across scans: hash of (rule, file, normalized snippet).
     * Enables resolved/introduced diffing without line-number churn.
     */
    fingerprint: text('fingerprint').notNull(),
    ruleId: text('rule_id').notNull(),
    scannerId: text('scanner_id').notNull(),
    severity: text('severity').$type<Severity>().notNull(),
    category: text('category').$type<Category>().notNull(),
    status: text('status').$type<FindingStatus>().notNull().default('open'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    filePath: text('file_path'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    /** Redacted code excerpt. Secret values are NEVER stored here. */
    evidence: text('evidence'),
    confidence: real('confidence').notNull().default(0.8),
    whyItMatters: text('why_it_matters'),
    remediation: text('remediation'),
    /** e.g. CWE-798, OWASP A07 — for security findings. */
    references: jsonb('references').$type<Array<{ label: string; url?: string }>>().notNull().default([]),
    relatedTests: jsonb('related_tests').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Cached AI explanation (generated on demand, never at scan time). */
    aiExplanation: text('ai_explanation'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('findings_scan_idx').on(t.scanId),
    index('findings_repo_status_idx').on(t.repositoryId, t.status),
    index('findings_fingerprint_idx').on(t.repositoryId, t.fingerprint),
    index('findings_severity_idx').on(t.severity),
  ],
);

/* -------------------------------------------------------------------------- */
/* Repository intelligence                                                    */
/* -------------------------------------------------------------------------- */

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    language: text('language'),
    loc: integer('loc').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    /** Resolved internal imports — powers the dependency/import graph. */
    imports: jsonb('imports').$type<string[]>().notNull().default([]),
    exports: jsonb('exports').$type<string[]>().notNull().default([]),
    /** Detected role: route | component | service | test | config | infra. */
    kind: text('kind'),
    /** Cyclomatic-ish complexity estimate from AST analysis. */
    complexity: integer('complexity').default(0),
    /** Git-history derived churn — used by technical-debt radar. */
    churn: integer('churn').default(0),
    riskScore: real('risk_score').default(0),
    contentHash: text('content_hash'),
    ...timestamps,
  },
  (t) => [
    index('files_repo_path_idx').on(t.repositoryId, t.path),
    index('files_scan_idx').on(t.scanId),
  ],
);

export const dependencies = pgTable(
  'dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'cascade' }),
    ecosystem: text('ecosystem').notNull().default('npm'),
    name: text('name').notNull(),
    version: text('version'),
    versionSpec: text('version_spec'),
    isDev: boolean('is_dev').notNull().default(false),
    isDirect: boolean('is_direct').notNull().default(true),
    manifestPath: text('manifest_path'),
    /** Vulnerability records from the OSV.dev API (real data, cached). */
    vulnerabilities: jsonb('vulnerabilities').$type<
      Array<{ id: string; severity: Severity; summary: string; fixedIn?: string; url?: string }>
    >().notNull().default([]),
    latestVersion: text('latest_version'),
    ...timestamps,
  },
  (t) => [
    index('dependencies_repo_idx').on(t.repositoryId),
    uniqueIndex('dependencies_scan_name_idx').on(t.scanId, t.ecosystem, t.name, t.manifestPath),
  ],
);

export const tests = pgTable(
  'tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    framework: text('framework'),
    testCount: integer('test_count').notNull().default(0),
    /** Source files this test appears to cover (import-graph derived). */
    coversPaths: jsonb('covers_paths').$type<string[]>().notNull().default([]),
    hasAssertions: boolean('has_assertions').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('tests_repo_idx').on(t.repositoryId), index('tests_scan_idx').on(t.scanId)],
);

/* -------------------------------------------------------------------------- */
/* Health, fixes, notifications                                               */
/* -------------------------------------------------------------------------- */

export const healthSnapshots = pgTable(
  'health_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'set null' }),
    health: real('health').notNull(),
    security: real('security').notNull(),
    reliability: real('reliability').notNull(),
    quality: real('quality').notNull(),
    testing: real('testing').notNull(),
    performance: real('performance').notNull(),
    /** Counts by severity at snapshot time. */
    counts: jsonb('counts').$type<Record<Severity, number>>().notNull().default({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    }),
    issuesResolved: integer('issues_resolved').notNull().default(0),
    issuesIntroduced: integer('issues_introduced').notNull().default(0),
    /** Estimated remediation effort in hours — technical debt radar. */
    debtHours: real('debt_hours').notNull().default(0),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('health_repo_created_idx').on(t.repositoryId, t.createdAt)],
);

export const fixes = pgTable(
  'fixes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** 'deterministic' (rule-authored codemod) or 'ai' (LLM-suggested). */
    origin: text('origin').notNull().default('deterministic'),
    /** proposed -> approved -> applied | rejected. Never auto-applied. */
    status: text('status').notNull().default('proposed'),
    title: text('title').notNull(),
    explanation: text('explanation'),
    /** Unified diff. Reviewed by a human before anything happens. */
    patch: text('patch'),
    originalCode: text('original_code'),
    fixedCode: text('fixed_code'),
    suggestedTest: text('suggested_test'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('fixes_finding_idx').on(t.findingId), index('fixes_repo_status_idx').on(t.repositoryId, t.status)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);

/* -------------------------------------------------------------------------- */
/* AI: request ledger & repository memory                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every AI call, successful or not.
 *
 * One table serves two jobs deliberately:
 *  - **Activity log** — what was asked, which provider answered, how long it
 *    took, which evidence it saw. Users can audit the AI rather than trust it.
 *  - **Cache** — a completed row for the same `cacheKey` is reused instead of
 *    paying for an identical call. The key is a hash of task + model + the
 *    exact evidence, so any change in grounding produces a fresh answer.
 *
 * SECURITY: `response` holds the parsed, schema-validated result only. The
 * prompt is NEVER stored — prompts contain repository source, and even after
 * redaction that is content we have no reason to retain.
 */
export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'set null' }),
    /** Task name, e.g. explain_finding | generate_fix | pr_review | chat. */
    task: text('task').notNull(),
    /** Provider that actually answered ('featherless' | 'groq'), null if none did. */
    provider: text('provider'),
    model: text('model'),
    status: text('status').$type<AIRequestStatus>().notNull(),
    durationMs: integer('duration_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Providers tried before this one succeeded — proves fallback behaviour. */
    attempts: jsonb('attempts').$type<Array<{ provider: string; error: string }>>().notNull().default([]),
    /** What grounded the answer: file paths, finding ids, commit shas. */
    evidenceSources: jsonb('evidence_sources').$type<string[]>().notNull().default([]),
    /** Redaction rule names that fired. Never the redacted values. */
    redactedKinds: jsonb('redacted_kinds').$type<string[]>().notNull().default([]),
    cacheKey: text('cache_key'),
    response: jsonb('response').$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('ai_requests_repo_created_idx').on(t.repositoryId, t.createdAt),
    index('ai_requests_cache_idx').on(t.cacheKey),
    index('ai_requests_finding_idx').on(t.findingId),
  ],
);

/**
 * Durable facts a maintainer has told CodeSentinel about the repository:
 * architecture decisions, intentional exceptions, accepted risks, conventions.
 *
 * These are authored by humans and are treated as authoritative context in
 * prompts. An AI guess NEVER writes here — that would let a hallucination
 * harden into a rule that shapes every later answer.
 */
export const repositoryMemory = pgTable(
  'repository_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MemoryKind>().notNull().default('decision'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Optional paths this fact applies to, for relevance filtering. */
    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('repository_memory_repo_idx').on(t.repositoryId, t.kind)],
);

/* -------------------------------------------------------------------------- */
/* Digital twin: symbols, graph edges, components, index state (Phase 5)      */
/* -------------------------------------------------------------------------- */

/**
 * Symbols extracted from source by the language parsers.
 *
 * One row per declaration that is worth reasoning about — functions, classes,
 * methods, exported types, detected routes. Bodies are NOT stored: the twin
 * records where a symbol lives and what shape it has, and reads the actual
 * source from disk on demand. Storing bodies would duplicate the repository
 * into the database and turn every re-index into a large write.
 */
export const symbols = pgTable(
  'symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Owning file path (repository-relative, POSIX). */
    filePath: text('file_path').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<SymbolKind>().notNull(),
    lineStart: integer('line_start').notNull().default(0),
    lineEnd: integer('line_end').notNull().default(0),
    isExported: boolean('is_exported').notNull().default(false),
    isAsync: boolean('is_async').notNull().default(false),
    /** Parameter names in declaration order — enough to generate a test call. */
    parameters: jsonb('parameters').$type<string[]>().notNull().default([]),
    /** Declaring class/interface for methods, else null. */
    parentName: text('parent_name'),
    /** Branching constructs inside the symbol — drives test-gap scenarios. */
    complexity: integer('complexity').notNull().default(0),
    /** Signature text, already stripped of the body. */
    signature: text('signature'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('symbols_repo_file_idx').on(t.repositoryId, t.filePath),
    index('symbols_repo_name_idx').on(t.repositoryId, t.name),
    index('symbols_repo_kind_idx').on(t.repositoryId, t.kind),
  ],
);

/**
 * Edges of the codebase graph.
 *
 * Endpoints are stored as opaque string keys (a file path, a `path#symbol`
 * reference, a dependency name, a component id) rather than foreign keys,
 * because an edge can point at a node type that has no table of its own —
 * and because a path survives a re-index while a row id does not.
 *
 * `evidence` carries the reason the edge exists (the import specifier, the
 * matched route literal, the call site line). Every edge shown in the UI can
 * therefore be justified, which is what keeps "never invent relationships"
 * enforceable rather than aspirational.
 */
export const codeEdges = pgTable(
  'code_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    type: text('type').$type<EdgeType>().notNull(),
    fromKey: text('from_key').notNull(),
    toKey: text('to_key').notNull(),
    confidence: text('confidence').$type<EdgeConfidence>().notNull().default('certain'),
    /** Why this edge exists — specifier, matched literal, or call site. */
    evidence: text('evidence'),
    lineNumber: integer('line_number'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('code_edges_unique_idx').on(t.repositoryId, t.type, t.fromKey, t.toKey),
    index('code_edges_from_idx').on(t.repositoryId, t.fromKey, t.type),
    index('code_edges_to_idx').on(t.repositoryId, t.toKey, t.type),
  ],
);

/**
 * Logical components — groups of files that belong together.
 *
 * Derived from directory structure and file role, not hand-maintained. The
 * architecture map renders components rather than files: a few dozen labelled
 * boxes are readable, several hundred file nodes are not.
 */
export const components = pgTable(
  'components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Stable slug, e.g. "src-services-auth". Referenced by code_edges keys. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Architectural layer: Frontend | API | Services | Data | Tests | Config | Other. */
    layer: text('layer').notNull().default('Other'),
    /** Directory prefix this component owns. */
    rootPath: text('root_path').notNull(),
    filePaths: jsonb('file_paths').$type<string[]>().notNull().default([]),
    fileCount: integer('file_count').notNull().default(0),
    loc: integer('loc').notNull().default(0),
    /** Denormalized counters — see docs/digital-twin.md for the formula. */
    dependencyCount: integer('dependency_count').notNull().default(0),
    dependentCount: integer('dependent_count').notNull().default(0),
    findingCount: integer('finding_count').notNull().default(0),
    criticalCount: integer('critical_count').notNull().default(0),
    testCount: integer('test_count').notNull().default(0),
    /** Files in this component that no test reaches. */
    untestedFiles: integer('untested_files').notNull().default(0),
    /** 30-day commit touches across the component's files. */
    changeFrequency: integer('change_frequency').notNull().default(0),
    /** True when the component handles auth, payments, crypto or raw SQL. */
    securitySensitive: boolean('security_sensitive').notNull().default(false),
    riskScore: real('risk_score').notNull().default(0),
    /** low | medium | high | critical — banded from riskScore. */
    riskLevel: text('risk_level').notNull().default('low'),
    /** Per-factor breakdown so the heatmap can explain every number. */
    riskFactors: jsonb('risk_factors')
      .$type<Array<{ label: string; points: number; detail: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('components_repo_key_idx').on(t.repositoryId, t.key),
    index('components_repo_risk_idx').on(t.repositoryId, t.riskScore),
  ],
);

/**
 * Per-file index state — the incremental indexing ledger.
 *
 * Holds the content hash the twin was last built from. A re-index compares
 * hashes and only reparses what changed, so an unchanged repository costs a
 * hash comparison per file instead of a full AST pass.
 */
export const indexState = pgTable(
  'index_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    contentHash: text('content_hash').notNull(),
    language: text('language'),
    symbolCount: integer('symbol_count').notNull().default(0),
    edgeCount: integer('edge_count').notNull().default(0),
    /** Wall-clock cost of parsing this file, for performance reporting. */
    parseMs: integer('parse_ms').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('index_state_repo_path_idx').on(t.repositoryId, t.filePath)],
);

/**
 * Regression memory: finding → fix → the test that proves it stays fixed.
 *
 * Written when a fix is applied, read when a new finding resembles an old one
 * ("this looks like something you already fixed"). The rule id plus a
 * normalized signature is what makes the resemblance check deterministic
 * rather than a vibe from an LLM.
 */
export const regressionMemory = pgTable(
  'regression_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'set null' }),
    fixId: uuid('fix_id').references(() => fixes.id, { onDelete: 'set null' }),
    ruleId: text('rule_id').notNull(),
    filePath: text('file_path'),
    /** Normalized shape of the original finding, for similarity matching. */
    signature: text('signature').notNull(),
    title: text('title').notNull(),
    /** The regression test source, if one was generated and kept. */
    testCode: text('test_code'),
    testPath: text('test_path'),
    testFramework: text('test_framework'),
    /** generated | running | passed | failed | not_run */
    testStatus: text('test_status').$type<GeneratedTestStatus>().notNull().default('not_run'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('regression_memory_repo_rule_idx').on(t.repositoryId, t.ruleId),
    index('regression_memory_repo_idx').on(t.repositoryId),
  ],
);

/** Team access control. */
export const repositoryMembers = pgTable(
  'repository_members',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.userId] })],
);

/* -------------------------------------------------------------------------- */
/* Guardian: webhook intake & scan jobs                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ledger of received GitHub webhook deliveries.
 *
 * GitHub retries deliveries and can send duplicates, so the delivery id is
 * UNIQUE: the handler records the delivery first and treats a conflict as
 * "already handled", which makes webhook processing idempotent. It also gives
 * operators a visible audit trail of what arrived and what it produced —
 * the raw payload is deliberately NOT stored (it contains repository content
 * and tokens); only routing metadata and the outcome.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** X-GitHub-Delivery header — the idempotency key. */
    deliveryId: text('delivery_id').notNull(),
    event: text('event').notNull(),
    action: text('action'),
    repositoryFullName: text('repository_full_name'),
    installationId: integer('installation_id'),
    /** received | ignored | processed | failed */
    status: text('status').$type<WebhookStatus>().notNull().default('received'),
    /** Why it was ignored, or the error when it failed. */
    message: text('message'),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('webhook_deliveries_delivery_idx').on(t.deliveryId),
    index('webhook_deliveries_created_idx').on(t.createdAt),
    index('webhook_deliveries_repo_idx').on(t.repositoryFullName),
  ],
);

/**
 * Durable scan queue.
 *
 * A webhook must answer GitHub fast (they time out at ~10s) while a scan takes
 * much longer, so the handler enqueues a job and returns. The row is the unit
 * of retry and the reason a scan survives a process restart; `attempts` and
 * `lockedAt` let a worker claim work without a broker. Deliberately a table,
 * not Redis: one fewer service to run, and the queue is inspectable in the UI.
 */
export const scanJobs = pgTable(
  'scan_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** queued | running | completed | failed | cancelled */
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    trigger: text('trigger').notNull().default('manual'),
    commitSha: text('commit_sha'),
    ref: text('ref'),
    pullRequestNumber: integer('pull_request_number'),
    /** Higher runs first: pull requests outrank scheduled sweeps. */
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Set when a worker claims the job; cleared on completion. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'set null' }),
    deliveryId: text('delivery_id'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('scan_jobs_status_idx').on(t.status, t.priority),
    index('scan_jobs_repo_idx').on(t.repositoryId, t.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  repositories: many(repositories),
  memberships: many(repositoryMembers),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  owner: one(users, { fields: [repositories.ownerUserId], references: [users.id] }),
  installation: one(installations, { fields: [repositories.installationId], references: [installations.id] }),
  policy: one(repositoryPolicies),
  scans: many(scans),
  findings: many(findings),
  files: many(files),
  dependencies: many(dependencies),
  tests: many(tests),
  snapshots: many(healthSnapshots),
  members: many(repositoryMembers),
}));

export const scansRelations = relations(scans, ({ one, many }) => ({
  repository: one(repositories, { fields: [scans.repositoryId], references: [repositories.id] }),
  pullRequest: one(pullRequests, { fields: [scans.pullRequestId], references: [pullRequests.id] }),
  findings: many(findings),
}));

export const findingsRelations = relations(findings, ({ one, many }) => ({
  scan: one(scans, { fields: [findings.scanId], references: [scans.id] }),
  repository: one(repositories, { fields: [findings.repositoryId], references: [repositories.id] }),
  fixes: many(fixes),
}));

export const fixesRelations = relations(fixes, ({ one }) => ({
  finding: one(findings, { fields: [fixes.findingId], references: [findings.id] }),
}));

export const sqlNow = sql`now()`;
