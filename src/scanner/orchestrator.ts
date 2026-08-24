import { createLogger } from '@/lib/logger';
import { discoverFiles, summarizeFiles, type RepositoryStats } from './discovery';
import { countByCategory, countBySeverity, dedupeFindings } from './finding';
import { OfflineAdvisoryProvider } from './providers/vulnerability-provider';
import { SCANNERS } from './registry';
import { calculateScores, type ScoringResult } from './scoring';
import type {
  Finding,
  ParsedDependency,
  ScanContext,
  Scanner,
  ScannerRun,
  SourceFile,
  VulnerabilityProvider,
  VulnerabilityRecord,
} from './types';

/**
 * Scan orchestration.
 *
 * Runs every available scanner over one discovered file set, merges the
 * results and computes scores. Design rules:
 *
 *   - One discovery pass, shared by all scanners. Files are read once.
 *   - A scanner that throws is recorded as `error` and the run continues. One
 *     bad rule must never lose the other scanners' findings.
 *   - A scanner whose prerequisites are missing is recorded as `skipped`, never
 *     silently reported as "no findings".
 *   - Scanners run concurrently; they are pure functions of the context.
 */

const log = createLogger('scanner');

export interface RunScanOptions {
  repositoryId: string;
  rootDir: string;
  scanners?: Scanner[];
  vulnerabilityProvider?: VulnerabilityProvider;
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  findings: Finding[];
  runs: ScannerRun[];
  stats: RepositoryStats;
  /** The exact file set every scanner saw — reused for repository intelligence. */
  files: SourceFile[];
  scores: ScoringResult;
  severityCounts: ReturnType<typeof countBySeverity>;
  categoryCounts: Record<string, number>;
  durationMs: number;
  /** Which vulnerability data source was used, for honest UI attribution. */
  vulnerabilityProvider: string;
  /**
   * Everything the provider returned during this scan, keyed
   * `"{ecosystem}:{name}"`. Captured as the dependency scanner runs so
   * persistence can store per-dependency advisories without a second lookup.
   */
  vulnerabilities: Map<string, VulnerabilityRecord[]>;
}

/**
 * Wraps a provider so the orchestrator can see what it returned.
 *
 * The dependency scanner owns the lookup call, but the results are also needed
 * to populate the `dependencies` table. Recording them here avoids a duplicate
 * (and potentially networked) lookup.
 */
class RecordingProvider implements VulnerabilityProvider {
  readonly name: string;
  readonly description: string;
  readonly recorded = new Map<string, VulnerabilityRecord[]>();

  constructor(private readonly inner: VulnerabilityProvider) {
    this.name = inner.name;
    this.description = inner.description;
  }

  async lookup(deps: ParsedDependency[]): Promise<Map<string, VulnerabilityRecord[]>> {
    const result = await this.inner.lookup(deps);
    for (const [key, records] of result) this.recorded.set(key, records);
    return result;
  }
}

/** Hard ceiling so one pathological file can't hang a scan. */
const SCANNER_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function runScan(options: RunScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const scanners = options.scanners ?? SCANNERS;
  const provider = new RecordingProvider(options.vulnerabilityProvider ?? new OfflineAdvisoryProvider());

  log.info('Scan started', { repositoryId: options.repositoryId, rootDir: options.rootDir });

  const files = await discoverFiles(options.rootDir, { maxFiles: options.maxFiles });
  const stats = summarizeFiles(files);

  const context: ScanContext = {
    repositoryId: options.repositoryId,
    rootDir: options.rootDir,
    files,
    fileByPath: new Map(files.map((file) => [file.path, file])),
    logger: {
      info: (msg, meta) => log.info(msg, meta),
      warn: (msg, meta) => log.warn(msg, meta),
      error: (msg, meta) => log.error(msg, meta),
    },
    vulnerabilityProvider: provider,
    signal: options.signal,
  };

  log.info('Files discovered', { files: stats.fileCount, loc: stats.totalLoc });

  const settled = await Promise.all(
    scanners.map(async (scanner): Promise<{ run: ScannerRun; findings: Finding[] }> => {
      const scannerStart = Date.now();
      try {
        const available = await scanner.isAvailable(context);
        if (!available) {
          return {
            run: {
              id: scanner.id,
              status: 'skipped',
              durationMs: Date.now() - scannerStart,
              findings: 0,
              message: 'Prerequisites not available in this environment.',
            },
            findings: [],
          };
        }

        const findings = await withTimeout(scanner.scan(context), SCANNER_TIMEOUT_MS, scanner.id);
        return {
          run: { id: scanner.id, status: 'ok', durationMs: Date.now() - scannerStart, findings: findings.length },
          findings,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Scanner failed', { scanner: scanner.id, message });
        return {
          run: { id: scanner.id, status: 'error', durationMs: Date.now() - scannerStart, findings: 0, message },
          findings: [],
        };
      }
    }),
  );

  const runs = settled.map((entry) => entry.run);
  const findings = dedupeFindings(settled.flatMap((entry) => entry.findings));
  const scores = calculateScores(findings, stats);
  const durationMs = Date.now() - startedAt;

  log.info('Scan finished', {
    repositoryId: options.repositoryId,
    findings: findings.length,
    health: scores.health,
    durationMs,
  });

  return {
    findings,
    runs,
    stats,
    files,
    scores,
    severityCounts: countBySeverity(findings),
    categoryCounts: countByCategory(findings),
    durationMs,
    vulnerabilityProvider: provider.name,
    vulnerabilities: provider.recorded,
  };
}
