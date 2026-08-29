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

  files: SourceFile[];
  scores: ScoringResult;
  severityCounts: ReturnType<typeof countBySeverity>;
  categoryCounts: Record<string, number>;
  durationMs: number;

  vulnerabilityProvider: string;





  vulnerabilities: Map<string, VulnerabilityRecord[]>;
}








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
