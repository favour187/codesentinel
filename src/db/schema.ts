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















export const FINDING_STATUSES = [
  'open',
  'proposed',
  'superseded',
  'resolved',
  'ignored',
  'false_positive',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];


export const SOURCES = ['github', 'demo'] as const;
export type RepoSource = (typeof SOURCES)[number];


export const WEBHOOK_STATUSES = ['received', 'ignored', 'processed', 'failed'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];


export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];


export const MEMORY_KINDS = ['decision', 'exception', 'accepted_risk', 'policy', 'convention'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];


export const GUARDIAN_EVENT_TYPES = [
  'CODE_CHANGED',
  'DEPENDENCY_CHANGED',
  'PR_OPENED',
  'PR_ANALYZED',
  'TEST_FAILED',
  'FINDING_CREATED',
  'FINDING_RESOLVED',
  'FINDING_REGRESSED',
  'SECRET_DETECTED',
  'HEALTH_CHANGED',
  'CONFIG_CHANGED',
  'SCAN_COMPLETED',
  'FIX_VERIFIED',
  'POLICY_TRIGGERED',
] as const;
export type GuardianEventType = (typeof GUARDIAN_EVENT_TYPES)[number];

export const POLICY_TRIGGERS = [
  'new_finding',
  'secret_detected',
  'dependency_change',
  'test_gap',
  'health_drop',
  'regression',
] as const;
export type PolicyTrigger = (typeof POLICY_TRIGGERS)[number];

export const POLICY_ACTIONS = ['request_changes', 'warn', 'notify', 'run_analysis'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];


export const AI_REQUEST_STATUSES = ['ok', 'failed', 'unavailable', 'cached'] as const;
export type AIRequestStatus = (typeof AI_REQUEST_STATUSES)[number];











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


export const EDGE_CONFIDENCE = ['certain', 'probable'] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCE)[number];








export const GENERATED_TEST_STATUSES = ['generated', 'running', 'passed', 'failed', 'not_run'] as const;
export type GeneratedTestStatus = (typeof GENERATED_TEST_STATUSES)[number];

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};





export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: integer('github_id').notNull(),
    login: text('login').notNull(),
    name: text('name'),
    email: text('email'),
    avatarUrl: text('avatar_url'),

    accessTokenEncrypted: text('access_token_encrypted'),
    tokenScopes: text('token_scopes'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_github_id_idx').on(t.githubId), index('users_login_idx').on(t.login)],
);


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





export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

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

    guardianEnabled: boolean('guardian_enabled').notNull().default(false),
    lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('repositories_full_name_source_idx').on(t.fullName, t.source),
    index('repositories_owner_user_idx').on(t.ownerUserId),
  ],
);


export const repositoryPolicies = pgTable(
  'repository_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    failOnSeverity: text('fail_on_severity').$type<Severity>().notNull().default('high'),

    enabledScanners: jsonb('enabled_scanners').$type<string[]>().notNull().default([]),
    scanOnPush: boolean('scan_on_push').notNull().default(true),
    scanOnPullRequest: boolean('scan_on_pull_request').notNull().default(true),
    postPrComments: boolean('post_pr_comments').notNull().default(true),
    createChecks: boolean('create_checks').notNull().default(true),

    scanSchedule: text('scan_schedule').notNull().default('daily'),
    ignorePaths: jsonb('ignore_paths').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex('repository_policies_repo_idx').on(t.repositoryId)],
);





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

    riskLevel: text('risk_level').$type<Severity>(),
    riskScore: real('risk_score'),

    riskFactors: jsonb('risk_factors').$type<Array<{ id: string; label: string; points: number; detail: string }>>()
      .notNull()
      .default([]),




    commentExternalId: text('comment_external_id'),
    filesChanged: integer('files_changed').default(0),
    additions: integer('additions').default(0),
    deletions: integer('deletions').default(0),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('pull_requests_repo_number_idx').on(t.repositoryId, t.number)],
);





export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    status: text('status').$type<ScanStatus>().notNull().default('queued'),

    trigger: text('trigger').notNull().default('manual'),
    commitSha: text('commit_sha'),
    ref: text('ref'),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id, { onDelete: 'set null' }),

    scannerRuns: jsonb('scanner_runs').$type<
      Array<{ id: string; status: 'ok' | 'error' | 'skipped'; durationMs: number; findings: number; message?: string }>
    >().notNull().default([]),
    filesScanned: integer('files_scanned').notNull().default(0),
    linesScanned: integer('lines_scanned').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),




    baseScanId: uuid('base_scan_id'),

    checkRunId: text('check_run_id'),

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

    evidence: text('evidence'),
    confidence: real('confidence').notNull().default(0.8),
    whyItMatters: text('why_it_matters'),
    remediation: text('remediation'),

    references: jsonb('references').$type<Array<{ label: string; url?: string }>>().notNull().default([]),
    relatedTests: jsonb('related_tests').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),

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

    imports: jsonb('imports').$type<string[]>().notNull().default([]),
    exports: jsonb('exports').$type<string[]>().notNull().default([]),

    kind: text('kind'),

    complexity: integer('complexity').default(0),

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

    coversPaths: jsonb('covers_paths').$type<string[]>().notNull().default([]),
    hasAssertions: boolean('has_assertions').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('tests_repo_idx').on(t.repositoryId), index('tests_scan_idx').on(t.scanId)],
);





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

    counts: jsonb('counts').$type<Record<Severity, number>>().notNull().default({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    }),
    issuesResolved: integer('issues_resolved').notNull().default(0),
    issuesIntroduced: integer('issues_introduced').notNull().default(0),

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

    origin: text('origin').notNull().default('deterministic'),

    status: text('status').notNull().default('proposed'),
    title: text('title').notNull(),
    explanation: text('explanation'),

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



















export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'set null' }),

    task: text('task').notNull(),

    provider: text('provider'),
    model: text('model'),
    status: text('status').$type<AIRequestStatus>().notNull(),
    durationMs: integer('duration_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),

    attempts: jsonb('attempts').$type<Array<{ provider: string; error: string }>>().notNull().default([]),

    evidenceSources: jsonb('evidence_sources').$type<string[]>().notNull().default([]),

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

    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    source: text('source').notNull().default('human'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('repository_memory_repo_idx').on(t.repositoryId, t.kind)],
);


export const guardianEvents = pgTable(
  'guardian_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    type: text('type').$type<GuardianEventType>().notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    level: text('level').notNull().default('info'),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('guardian_events_repo_created_idx').on(t.repositoryId, t.createdAt),
    uniqueIndex('guardian_events_dedupe_idx').on(t.repositoryId, t.dedupeKey),
  ],
);


export const policyRules = pgTable(
  'policy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    name: text('name').notNull(),
    trigger: text('trigger').$type<PolicyTrigger>().notNull(),
    condition: jsonb('condition')
      .$type<{ severity?: Severity; risk?: string; category?: string }>()
      .notNull()
      .default({}),
    action: text('action').$type<PolicyAction>().notNull(),
    ...timestamps,
  },
  (t) => [index('policy_rules_repo_idx').on(t.repositoryId)],
);














export const symbols = pgTable(
  'symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    filePath: text('file_path').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<SymbolKind>().notNull(),
    lineStart: integer('line_start').notNull().default(0),
    lineEnd: integer('line_end').notNull().default(0),
    isExported: boolean('is_exported').notNull().default(false),
    isAsync: boolean('is_async').notNull().default(false),

    parameters: jsonb('parameters').$type<string[]>().notNull().default([]),

    parentName: text('parent_name'),

    complexity: integer('complexity').notNull().default(0),

    signature: text('signature'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('symbols_repo_file_idx').on(t.repositoryId, t.filePath),
    index('symbols_repo_name_idx').on(t.repositoryId, t.name),
    index('symbols_repo_kind_idx').on(t.repositoryId, t.kind),
  ],
);














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








export const components = pgTable(
  'components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    key: text('key').notNull(),
    name: text('name').notNull(),

    layer: text('layer').notNull().default('Other'),

    rootPath: text('root_path').notNull(),
    filePaths: jsonb('file_paths').$type<string[]>().notNull().default([]),
    fileCount: integer('file_count').notNull().default(0),
    loc: integer('loc').notNull().default(0),

    dependencyCount: integer('dependency_count').notNull().default(0),
    dependentCount: integer('dependent_count').notNull().default(0),
    findingCount: integer('finding_count').notNull().default(0),
    criticalCount: integer('critical_count').notNull().default(0),
    testCount: integer('test_count').notNull().default(0),

    untestedFiles: integer('untested_files').notNull().default(0),

    changeFrequency: integer('change_frequency').notNull().default(0),

    securitySensitive: boolean('security_sensitive').notNull().default(false),
    riskScore: real('risk_score').notNull().default(0),

    riskLevel: text('risk_level').notNull().default('low'),

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

    parseMs: integer('parse_ms').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('index_state_repo_path_idx').on(t.repositoryId, t.filePath)],
);









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

    signature: text('signature').notNull(),
    title: text('title').notNull(),

    testCode: text('test_code'),
    testPath: text('test_path'),
    testFramework: text('test_framework'),

    testStatus: text('test_status').$type<GeneratedTestStatus>().notNull().default('not_run'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('regression_memory_repo_rule_idx').on(t.repositoryId, t.ruleId),
    index('regression_memory_repo_idx').on(t.repositoryId),
  ],
);


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















export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    deliveryId: text('delivery_id').notNull(),
    event: text('event').notNull(),
    action: text('action'),
    repositoryFullName: text('repository_full_name'),
    installationId: integer('installation_id'),

    status: text('status').$type<WebhookStatus>().notNull().default('received'),

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










export const scanJobs = pgTable(
  'scan_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    status: text('status').$type<JobStatus>().notNull().default('queued'),
    trigger: text('trigger').notNull().default('manual'),
    commitSha: text('commit_sha'),
    ref: text('ref'),
    pullRequestNumber: integer('pull_request_number'),

    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

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
