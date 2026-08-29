import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBlastRadius, hotspotPaths, impactBand, scoreImpact } from '@/analysis/blast-radius';
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






async function seedGraph() {
  return seedScan(db, repositoryId, {
    files: [
      { path: 'src/lib/db.ts', loc: 80, imports: [], kind: 'source' },
      { path: 'src/services/user.ts', loc: 120, imports: ['src/lib/db.ts'], kind: 'source' },
      { path: 'src/services/order.ts', loc: 90, imports: ['src/lib/db.ts'], kind: 'source' },
      { path: 'src/api/users/route.ts', loc: 60, imports: ['src/services/user.ts'], kind: 'route' },
      { path: 'src/lib/unused.ts', loc: 20, imports: [], kind: 'source' },
    ],
    tests: [{ filePath: 'tests/user.test.ts', coversPaths: ['src/services/user.ts'] }],
  });
}

describe('computeBlastRadius', () => {
  it('finds direct dependents', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');

    expect(radius.exists).toBe(true);
    expect(radius.directDependentCount).toBe(2);
    expect(radius.dependents.map((d) => d.path)).toContain('src/services/user.ts');
    expect(radius.dependents.map((d) => d.path)).toContain('src/services/order.ts');
  });

  it('follows the graph transitively and records depth', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');

    const route = radius.dependents.find((d) => d.path === 'src/api/users/route.ts');
    expect(route, 'indirect dependent should be found').toBeDefined();
    expect(route?.depth).toBe(2);

    const direct = radius.dependents.find((d) => d.path === 'src/services/user.ts');
    expect(direct?.depth).toBe(1);
  });

  it('reports what the file itself imports', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/services/user.ts');

    expect(radius.dependencies.map((d) => d.path)).toEqual(['src/lib/db.ts']);
  });

  it('reports an isolated file as having no dependents', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/lib/unused.ts');

    expect(radius.exists).toBe(true);
    expect(radius.directDependentCount).toBe(0);
    expect(radius.dependents).toEqual([]);
    expect(radius.impactLevel).toBe('low');
  });

  it('identifies affected routes', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');

    expect(radius.affectedRoutes).toContain('src/api/users/route.ts');
  });

  it('finds tests covering anything downstream', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');

    expect(radius.relatedTests).toContain('tests/user.test.ts');
  });

  it('flags security-sensitive areas in the affected set', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/lib/token.ts', imports: [] },
        { path: 'src/auth/session.ts', imports: ['src/lib/token.ts'] },
      ],
    });

    const radius = await computeBlastRadius(repositoryId, 'src/lib/token.ts');
    expect(radius.sensitiveAreas).toContain('authentication');
  });

  it('counts open findings across the affected set', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/lib/db.ts', imports: [] },
        { path: 'src/services/user.ts', imports: ['src/lib/db.ts'] },
      ],
      findings: [
        { filePath: 'src/lib/db.ts', severity: 'critical' },
        { filePath: 'src/services/user.ts', severity: 'high' },
        { filePath: 'src/unrelated.ts', severity: 'high' },
      ],
    });

    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');
    expect(radius.openFindings).toBe(2);
  });

  it('scores a widely-imported file above an isolated one', async () => {
    await seedGraph();

    const central = await computeBlastRadius(repositoryId, 'src/lib/db.ts');
    const isolated = await computeBlastRadius(repositoryId, 'src/lib/unused.ts');

    expect(central.impactScore).toBeGreaterThan(isolated.impactScore);
  });

  it('returns a non-existent result for an unknown path instead of throwing', async () => {
    await seedGraph();
    const radius = await computeBlastRadius(repositoryId, 'src/does/not/exist.ts');

    expect(radius.exists).toBe(false);
    expect(radius.impactScore).toBe(0);
  });

  it('returns an empty result when the repository has never been scanned', async () => {
    const radius = await computeBlastRadius(repositoryId, 'src/lib/db.ts');
    expect(radius.exists).toBe(false);
  });

  it('handles an import cycle without hanging', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/a.ts', imports: ['src/b.ts'] },
        { path: 'src/b.ts', imports: ['src/a.ts'] },
      ],
    });

    const radius = await computeBlastRadius(repositoryId, 'src/a.ts');
    expect(radius.dependents.map((d) => d.path)).toEqual(['src/b.ts']);
  });
});

describe('scoreImpact', () => {
  const base = {
    directDependents: 0,
    transitiveDependents: 0,
    routes: 0,
    sensitiveAreas: 0,
    hasTests: true,
    findingSeverities: [] as const,
  };

  it('scores nothing as zero', () => {
    expect(scoreImpact({ ...base })).toBe(0);
  });

  it('rises with dependents but sub-linearly', () => {
    const few = scoreImpact({ ...base, directDependents: 2 });
    const many = scoreImpact({ ...base, directDependents: 20 });
    const huge = scoreImpact({ ...base, directDependents: 200 });

    expect(many).toBeGreaterThan(few);
    expect(huge - many).toBeLessThan(many - few);
  });

  it('penalises untested central files', () => {
    const tested = scoreImpact({ ...base, directDependents: 5, hasTests: true });
    const untested = scoreImpact({ ...base, directDependents: 5, hasTests: false });

    expect(untested).toBeGreaterThan(tested);
  });

  it('does not penalise an untested leaf file', () => {
    const leaf = scoreImpact({ ...base, directDependents: 0, hasTests: false });
    expect(leaf).toBe(0);
  });

  it('weights sensitive areas heavily', () => {
    expect(scoreImpact({ ...base, sensitiveAreas: 2 })).toBeGreaterThanOrEqual(20);
  });

  it('never exceeds 100', () => {
    const worst = scoreImpact({
      directDependents: 500,
      transitiveDependents: 2000,
      routes: 50,
      sensitiveAreas: 10,
      hasTests: false,
      findingSeverities: Array.from({ length: 40 }, () => 'critical' as const),
    });

    expect(worst).toBeLessThanOrEqual(100);
  });
});

describe('impactBand', () => {
  it('maps scores to documented bands', () => {
    expect(impactBand(0)).toBe('low');
    expect(impactBand(19)).toBe('low');
    expect(impactBand(20)).toBe('medium');
    expect(impactBand(45)).toBe('high');
    expect(impactBand(70)).toBe('critical');
  });
});

describe('hotspotPaths', () => {
  it('ranks files by how many others import them', async () => {
    await seedGraph();
    const hotspots = await hotspotPaths(repositoryId);

    expect(hotspots[0]?.path).toBe('src/lib/db.ts');
    expect(hotspots[0]?.dependents).toBe(2);
  });

  it('returns nothing when there is no scan', async () => {
    expect(await hotspotPaths(repositoryId)).toEqual([]);
  });
});
