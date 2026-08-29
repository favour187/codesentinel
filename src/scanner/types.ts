import type { Category, Severity } from '@/db/schema';











export interface SourceFile {

  path: string;

  language: string;

  content: string;

  lines: string[];

  loc: number;
  bytes: number;

  isTest: boolean;

  contentHash: string;
}

export interface ScanContext {
  repositoryId: string;

  rootDir: string;
  files: SourceFile[];

  fileByPath: Map<string, SourceFile>;

  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };

  vulnerabilityProvider: VulnerabilityProvider;
  signal?: AbortSignal;
}









export interface Finding {

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

  evidence: string | null;

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





export interface ParsedDependency {
  ecosystem: 'npm' | 'PyPI';
  name: string;

  versionSpec: string;

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









export interface VulnerabilityProvider {
  name: string;

  description: string;
  lookup(dependencies: ParsedDependency[]): Promise<Map<string, VulnerabilityRecord[]>>;
}
