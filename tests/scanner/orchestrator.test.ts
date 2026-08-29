import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScan } from '@/scanner/orchestrator';
import { getScanner, SCANNERS } from '@/scanner/registry';
import type { Finding, Scanner, ScanContext } from '@/scanner/types';












let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), 'codesentinel-orch-'));
  await mkdir(path.join(repoDir, 'src'), { recursive: true });

  await writeFile(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'orch-fixture', dependencies: { lodash: '4.17.15' } }, null, 2),
  );
  await writeFile(
    path.join(repoDir, 'src', 'app.js'),
    [
      "const { exec } = require('child_process');",
      'function ping(req) {',
      "  exec('ping -c 1 ' + req.query.host);",
      '}',
      'module.exports = { ping };',
    ].join('\n'),
  );
  await writeFile(
    path.join(repoDir, 'Dockerfile'),
    ['FROM node:14', 'COPY . /app', 'CMD ["node", "src/app.js"]'].join('\n'),
  );
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

function stubScanner(id: string, overrides: Partial<Scanner> = {}): Scanner {
  return {
    id,
    name: `Stub ${id}`,
    description: 'test double',
    categories: ['quality'],
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async scan(): Promise<Finding[]> {
      return [];
    },
    ...overrides,
  };
}

describe('registry', () => {
  it('exposes the registered scanners with unique ids', () => {
    const ids = SCANNERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      ['cicd', 'config', 'dependencies', 'infrastructure', 'quality', 'secrets', 'security', 'testing'].sort(),
    );
  });

  it('looks a scanner up by id and returns undefined for an unknown one', () => {
    expect(getScanner('security')?.id).toBe('security');
    expect(getScanner('nope')).toBeUndefined();
  });

  it('gives every scanner a name, description and at least one category', () => {
    for (const scanner of SCANNERS) {
      expect(scanner.name, scanner.id).toBeTruthy();
      expect(scanner.description, scanner.id).toBeTruthy();
      expect(scanner.categories.length, scanner.id).toBeGreaterThan(0);
    }
  });
});

describe('runScan — real repository', () => {
  it('discovers files once and reports stats alongside findings', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });

    expect(result.stats.fileCount).toBeGreaterThan(0);
    expect(result.stats.totalLoc).toBeGreaterThan(0);
    expect(result.files.length).toBe(result.stats.fileCount);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs every registered scanner and records a run entry for each', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });

    expect(result.runs.map((r) => r.id).sort()).toEqual(SCANNERS.map((s) => s.id).sort());
    for (const run of result.runs) {
      expect(['ok', 'error', 'skipped'], run.id).toContain(run.status);
      expect(run.durationMs, run.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('finds the planted issues across several scanners', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });
    const scanners = new Set(result.findings.map((f) => f.scannerId));

    expect(scanners.has('security')).toBe(true);
    expect(scanners.has('dependencies')).toBe(true);
    expect(scanners.has('infrastructure')).toBe(true);
  });

  it('returns findings that are already deduplicated', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });
    const fingerprints = result.findings.map((f) => f.fingerprint);

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('computes scores and counts consistent with the findings', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });

    const totalBySeverity = Object.values(result.severityCounts).reduce((a, b) => a + b, 0);
    expect(totalBySeverity).toBe(result.findings.length);

    const totalByCategory = Object.values(result.categoryCounts).reduce((a, b) => a + b, 0);
    expect(totalByCategory).toBe(result.findings.length);

    expect(result.scores.health).toBeGreaterThanOrEqual(0);
    expect(result.scores.health).toBeLessThanOrEqual(100);
    expect(result.scores.counts).toEqual(result.severityCounts);
  });

  it('is deterministic across repeated runs of the same tree', async () => {
    const a = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });
    const b = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });

    expect(b.findings.map((f) => f.fingerprint).sort()).toEqual(
      a.findings.map((f) => f.fingerprint).sort(),
    );
    expect(b.scores.health).toBeCloseTo(a.scores.health, 5);
  });

  it('attributes the vulnerability data source and records what it returned', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir });

    expect(result.vulnerabilityProvider).toBeTruthy();


    expect(result.vulnerabilities.size).toBeGreaterThan(0);
    expect(result.vulnerabilities.has('npm:lodash')).toBe(true);
  });

  it('produces no findings for an empty directory', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'codesentinel-empty-'));
    try {
      const result = await runScan({ repositoryId: 'repo-empty', rootDir: empty });

      expect(result.findings).toEqual([]);
      expect(result.stats.fileCount).toBe(0);

      expect(result.scores.health).toBe(100);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('runScan — resilience', () => {
  it('records a throwing scanner as error and keeps the other results', async () => {
    const result = await runScan({
      repositoryId: 'repo-1',
      rootDir: repoDir,
      scanners: [
        stubScanner('exploding', {
          async scan(): Promise<Finding[]> {
            throw new Error('rule blew up');
          },
        }),
        SCANNERS.find((s) => s.id === 'security')!,
      ],
    });

    const failed = result.runs.find((r) => r.id === 'exploding');
    expect(failed?.status).toBe('error');
    expect(failed?.message).toContain('rule blew up');
    expect(failed?.findings).toBe(0);


    const ok = result.runs.find((r) => r.id === 'security');
    expect(ok?.status).toBe('ok');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('records an unavailable scanner as skipped, not as a clean result', async () => {
    const result = await runScan({
      repositoryId: 'repo-1',
      rootDir: repoDir,
      scanners: [
        stubScanner('unavailable', {
          async isAvailable(): Promise<boolean> {
            return false;
          },
          async scan(): Promise<Finding[]> {
            throw new Error('scan must not be called when unavailable');
          },
        }),
      ],
    });

    const run = result.runs[0];
    expect(run?.status).toBe('skipped');
    expect(run?.message).toBeTruthy();
    expect(result.findings).toEqual([]);
  });

  it('treats a failure in isAvailable as an error rather than crashing the scan', async () => {
    const result = await runScan({
      repositoryId: 'repo-1',
      rootDir: repoDir,
      scanners: [
        stubScanner('bad-probe', {
          async isAvailable(): Promise<boolean> {
            throw new Error('probe failed');
          },
        }),
      ],
    });

    expect(result.runs[0]?.status).toBe('error');
    expect(result.runs[0]?.message).toContain('probe failed');
  });

  it('gives every scanner the same file set', async () => {
    const seen: number[] = [];
    const spy = (id: string) =>
      stubScanner(id, {
        async scan(ctx: ScanContext): Promise<Finding[]> {
          seen.push(ctx.files.length);
          expect(ctx.fileByPath.size).toBe(ctx.files.length);
          expect(ctx.repositoryId).toBe('repo-shared');
          return [];
        },
      });

    const result = await runScan({
      repositoryId: 'repo-shared',
      rootDir: repoDir,
      scanners: [spy('a'), spy('b'), spy('c')],
    });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(result.stats.fileCount);
  });

  it('honours maxFiles when discovering', async () => {
    const result = await runScan({ repositoryId: 'repo-1', rootDir: repoDir, maxFiles: 1 });
    expect(result.stats.fileCount).toBe(1);
  });
});
