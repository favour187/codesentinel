import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTechnicalDebt, isMajorBehind } from '@/analysis/technical-debt';
import { createTestDb, seedRepository, seedScan } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';







let db: TestDb;
let repositoryId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

beforeEach(async () => {
  db = await createTestDb();
  ({ repositoryId } = await seedRepository(db));
});

describe('computeTechnicalDebt', () => {
  it('returns zero for a repository with no scan', async () => {
    const debt = await computeTechnicalDebt(repositoryId);

    expect(debt.totalHours).toBe(0);
    expect(debt.contributors).toEqual([]);
  });

  it('returns zero contributors for a clean repository', async () => {
    await seedScan(db, repositoryId, {
      files: [{ path: 'src/a.ts', loc: 30, complexity: 3, kind: 'source' }],
      tests: [{ filePath: 'tests/a.test.ts', coversPaths: ['src/a.ts'] }],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    expect(debt.totalHours).toBe(0);
  });

  it('charges hours for open findings, weighted by severity', async () => {
    await seedScan(db, repositoryId, {
      findings: [
        { severity: 'critical', filePath: 'src/a.ts' },
        { severity: 'low', filePath: 'src/b.ts' },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    const findingDebt = debt.contributors.find((c) => c.id === 'findings');


    expect(findingDebt?.hours).toBe(4.5);
    expect(findingDebt?.count).toBe(2);
    expect(debt.metrics.openFindings).toBe(2);
  });

  it('ignores resolved findings', async () => {
    await seedScan(db, repositoryId, {
      findings: [
        { severity: 'critical', status: 'open' },
        { severity: 'critical', status: 'resolved' },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    expect(debt.metrics.openFindings).toBe(1);
  });

  it('charges for high-complexity files', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/simple.ts', complexity: 4 },
        { path: 'src/gnarly.ts', complexity: 60 },
        { path: 'src/worse.ts', complexity: 40 },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    const complexity = debt.contributors.find((c) => c.id === 'complexity');

    expect(complexity?.count).toBe(2);
    expect(debt.metrics.complexFiles).toBe(2);
    expect(complexity?.detail).toContain('src/gnarly.ts');
  });

  it('charges for untested source files but excludes tests and configs', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/covered.ts', loc: 50, kind: 'source' },
        { path: 'src/uncovered.ts', loc: 50, kind: 'source' },
        { path: 'src/tiny.ts', loc: 5, kind: 'source' },
        { path: 'tests/covered.test.ts', loc: 40, kind: 'test' },
        { path: 'next.config.ts', loc: 30, kind: 'config' },
      ],
      tests: [{ filePath: 'tests/covered.test.ts', coversPaths: ['src/covered.ts'] }],
    });

    const debt = await computeTechnicalDebt(repositoryId);



    expect(debt.metrics.untestedSourceFiles).toBe(1);
  });

  it('charges for vulnerable dependencies', async () => {
    await seedScan(db, repositoryId, {
      dependencies: [
        { name: 'safe-pkg', version: '1.0.0' },
        { name: 'bad-pkg', version: '1.0.0', vulnerabilities: [{ id: 'CVE-2024-1', severity: 'high' }] },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    const vuln = debt.contributors.find((c) => c.id === 'vulnerable-deps');

    expect(vuln?.count).toBe(1);
    expect(vuln?.detail).toContain('bad-pkg');
    expect(debt.metrics.vulnerableDependencies).toBe(1);
  });

  it('charges for dependencies a major version behind', async () => {
    await seedScan(db, repositoryId, {
      dependencies: [
        { name: 'current', version: '4.0.0', latestVersion: '4.2.0' },
        { name: 'stale', version: '2.1.0', latestVersion: '5.0.0' },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);

    expect(debt.metrics.staleDependencies).toBe(1);
    expect(debt.contributors.find((c) => c.id === 'stale-deps')?.count).toBe(1);
  });

  it('counts findings from a recurring rule', async () => {
    await seedScan(db, repositoryId, {
      findings: [
        { ruleId: 'quality/no-any', filePath: 'src/a.ts' },
        { ruleId: 'quality/no-any', filePath: 'src/b.ts' },
        { ruleId: 'quality/no-any', filePath: 'src/c.ts' },
        { ruleId: 'security/xss', filePath: 'src/d.ts' },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);

    expect(debt.metrics.recurringFindings).toBe(3);
  });

  it('sorts contributors by hours so the biggest problem leads', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/a.ts', loc: 50, complexity: 60 },
        { path: 'src/b.ts', loc: 50, complexity: 60 },
      ],
      findings: Array.from({ length: 10 }, (_, i) => ({ severity: 'critical' as const, filePath: `src/f${i}.ts` })),
    });

    const debt = await computeTechnicalDebt(repositoryId);
    const hours = debt.contributors.map((c) => c.hours);

    expect(hours).toEqual([...hours].sort((a, b) => b - a));
    expect(debt.contributors[0]?.id).toBe('findings');
  });

  it('totals the contributors', async () => {
    await seedScan(db, repositoryId, {
      files: [{ path: 'src/a.ts', loc: 50, complexity: 60 }],
      findings: [{ severity: 'critical', filePath: 'src/a.ts' }],
    });

    const debt = await computeTechnicalDebt(repositoryId);
    const sum = debt.contributors.reduce((acc, c) => acc + c.hours, 0);

    expect(debt.totalHours).toBeCloseTo(sum, 1);
  });

  it('reports repository metrics alongside the estimate', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/a.ts', loc: 100 },
        { path: 'src/b.ts', loc: 60 },
      ],
    });

    const debt = await computeTechnicalDebt(repositoryId);

    expect(debt.metrics.fileCount).toBe(2);
    expect(debt.metrics.totalLoc).toBe(160);
  });
});

describe('isMajorBehind', () => {
  it('detects a major version gap', () => {
    expect(isMajorBehind('2.1.0', '5.0.0')).toBe(true);
    expect(isMajorBehind('1.0.0', '2.0.0')).toBe(true);
  });

  it('ignores minor and patch drift', () => {
    expect(isMajorBehind('4.0.0', '4.9.9')).toBe(false);
    expect(isMajorBehind('4.2.0', '4.2.1')).toBe(false);
  });

  it('handles version prefixes', () => {
    expect(isMajorBehind('^2.0.0', '4.0.0')).toBe(true);
    expect(isMajorBehind('~1.2.3', '1.9.0')).toBe(false);
  });

  it('is safe with unparseable versions', () => {
    expect(isMajorBehind('latest', '1.0.0')).toBe(false);
    expect(isMajorBehind('1.0.0', 'next')).toBe(false);
    expect(isMajorBehind('', '')).toBe(false);
  });

  it('does not report a newer local version as behind', () => {
    expect(isMajorBehind('5.0.0', '4.0.0')).toBe(false);
  });
});
