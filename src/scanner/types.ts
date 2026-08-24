import type { Category, Severity } from '@/db/schema';

/**
 * Core scanner contracts.
 *
 * Every scanner implements the same interface and returns the same Finding
 * shape, so the orchestrator can merge, dedupe and score results without
 * knowing anything about individual rules. Adding a scanner means adding one
 * module to the registry — nothing else changes.
 */

/** A source file discovered in the repository, already read into memory. */
export interface SourceFile {
  /** Repository-relative POSIX path, e.g. "src/routes/auth.js". */
  path: string;
  /** Detected language id, e.g. "javascript" | "python" | "dockerfile". */
  language: string;
  /** Full file contents. */
  content: string;
  /** Lines, split once and shared by all scanners (files can be large). */
  lines: string[];
  /** Non-empty line count. */
  loc: number;
  bytes: number;
  /** True when the path looks like a test file. */
  isTest: boolean;
  /** sha256 of the content — used for change detection. */
  contentHash: string;
}

export interface ScanContext {
  repositoryId: string;
  /** Absolute path of the checkout root being analysed. */
  rootDir: string;
  files: SourceFile[];
  /** Lookup by repository-relative path. */
  fileByPath: Map<string, SourceFile>;
  /** Emitted for progress/debug logging; never contains secret values. */
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Resolves vulnerability data for dependencies. Pluggable — see providers. */
  vulnerabilityProvider: VulnerabilityProvider;
  signal?: AbortSignal;
}

/**
 * A single detected issue.
 *
 * `evidence` is ALWAYS redacted: scanners that match credential material must
 * mask it before constructing the finding. This is enforced at construction
 * time (see createFinding) rather than in the UI, so a secret can never reach
 * the database in the first place.
 */
export interface Finding {
  /** Stable across scans: hash of (ruleId, filePath, normalized snippet). */
  fingerprint: string;
  ruleId: string;
  scannerId: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** Redacted excerpt showing why the rule fired. */
  evidence: string | null;
  /** 0..1 — how sure the rule is that this is a true positive. */
  confidence: number;
  whyItMatters: string | null;
  remediation: string | null;
  references: Array<{ label: string; url?: string }>;
  relatedTests: string[];
  metadata: Record<string, unknown>;
}

export interface Scanner {
  id: string;
  name: string;
  description: string;
  categories: Category[];
  /**
   * Whether this scanner can run in the current environment. Scanners that
   * shell out to external tools (Semgrep, package managers) return false when
   * the tool is absent, and the run records them as `skipped` instead of
   * silently producing zero findings — a missing tool must never look like a
   * clean result.
   */
  isAvailable(ctx: ScanContext): Promise<boolean>;
  scan(ctx: ScanContext): Promise<Finding[]>;
}

export interface ScannerRun {
  id: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  findings: number;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/* Dependency vulnerability provider                                          */
/* -------------------------------------------------------------------------- */

export interface ParsedDependency {
  ecosystem: 'npm' | 'PyPI';
  name: string;
  /** The raw spec from the manifest, e.g. "^4.17.1" or ">=2.0". */
  versionSpec: string;
  /** Best-effort concrete version parsed from the spec, if determinable. */
  version: string | null;
  isDev: boolean;
  isDirect: boolean;
  manifestPath: string;
  line: number | null;
}

export interface VulnerabilityRecord {
  id: string;
  severity: Severity;
  summary: string;
  fixedIn?: string;
  url?: string;
}

/**
 * Pluggable source of vulnerability intelligence.
 *
 * The MVP ships an offline advisory dataset so scans are deterministic and work
 * with no network. An OSV.dev-backed provider implements the same interface and
 * can be swapped in without touching the scanner. `name` is surfaced in the UI
 * so users always know which data source produced a dependency finding.
 */
export interface VulnerabilityProvider {
  name: string;
  /** Human-readable note about coverage/limits, shown in the UI. */
  description: string;
  lookup(dependencies: ParsedDependency[]): Promise<Map<string, VulnerabilityRecord[]>>;
}
