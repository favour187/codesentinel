import path from 'node:path';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { components as componentsTable } from '@/db/schema';
import { discoverFiles } from '@/scanner/discovery';

import { createTestDb, seedRepository, seedScan, type TestDb } from '../helpers/test-db';

let db: TestDb;

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return { ...actual, getDb: async () => db };
});

const { indexRepository } = await import('@/twin/indexer');
const { rebuildComponents, componentGraph, componentKeyOf, componentRootOf, layerOf, scoreComponentRisk, bandRisk } =
  await import('@/twin/components');

const FIXTURE_ROOT = path.join(process.cwd(), 'fixtures', 'demo-repo');

let repositoryId: string;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedRepository(db, { fullName: 'codesentinel/demo-repo' });
  repositoryId = seeded.repositoryId;
});

describe('file grouping', () => {
  it('groups files by directory, not one node per file', () => {
    expect(componentKeyOf('src/services/payment-service.js')).toBe('services');
    expect(componentKeyOf('src/services/billing/invoice.js')).toBe('services-billing');
    expect(componentKeyOf('package.json')).toBe('root');
  });

  it('strips a leading source root so the name reads naturally', () => {
    expect(componentRootOf('src/routes/auth.js')).toBe('routes');
    expect(componentRootOf('lib/http/client.ts')).toBe('http');
    // Only strips when there is something left to group by.
    expect(componentRootOf('src/index.ts')).toBe('(root)');
  });

  it('classifies files into architectural layers', () => {
    expect(layerOf('src/components/Button.tsx')).toBe('Frontend');
    expect(layerOf('src/routes/auth.js')).toBe('API');
    expect(layerOf('src/services/user.js')).toBe('Services');
    expect(layerOf('src/db/schema.ts')).toBe('Data');
    expect(layerOf('tests/auth.test.js')).toBe('Tests');
    expect(layerOf('Dockerfile')).toBe('Infrastructure');
    expect(layerOf('some/unmatched/thing.txt')).toBe('Other');
  });

  it('prefers the more specific rule when paths could match twice', () => {
    // Contains "auth" (Services) but lives under routes/ (API).
    expect(layerOf('src/routes/auth.js')).toBe('API');
    // A test for a service is a test first.
    expect(layerOf('tests/services/user.test.js')).toBe('Tests');
  });
});

describe('risk scoring', () => {
  const base = {
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    dependentCount: 0,
    untestedFiles: 0,
    fileCount: 4,
    changeFrequency: 0,
    securitySensitive: false,
  };

  it('scores a clean, unused, tested component at zero', () => {
    const risk = scoreComponentRisk(base);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.factors).toEqual([]);
  });

  it('explains every point it awards', () => {
    const risk = scoreComponentRisk({ ...base, criticalCount: 2, dependentCount: 3, untestedFiles: 2 });
    const total = risk.factors.reduce((sum, f) => sum + f.points, 0);
    // The score is the sum of its stated factors — nothing unaccounted for.
    expect(Math.abs(total - risk.score)).toBeLessThan(0.2);
    for (const factor of risk.factors) {
      expect(factor.detail.length).toBeGreaterThan(0);
    }
  });

  it('ranks a depended-upon, vulnerable, untested component above an isolated one', () => {
    const hot = scoreComponentRisk({ ...base, criticalCount: 3, dependentCount: 6, untestedFiles: 4, securitySensitive: true });
    const cold = scoreComponentRisk({ ...base, lowCount: 1 });
    expect(hot.score).toBeGreaterThan(cold.score);
    expect(hot.level).toBe('critical');
  });

  it('caps each factor so one dimension cannot dominate', () => {
    const absurd = scoreComponentRisk({ ...base, criticalCount: 500, dependentCount: 5000, changeFrequency: 100000 });
    expect(absurd.score).toBeLessThanOrEqual(100);
  });

  it('bands scores consistently', () => {
    expect(bandRisk(0)).toBe('low');
    expect(bandRisk(17.9)).toBe('low');
    expect(bandRisk(18)).toBe('medium');
    expect(bandRisk(40)).toBe('high');
    expect(bandRisk(65)).toBe('critical');
  });
});

describe('rebuildComponents against the demo fixture', () => {
  async function indexAndBuild() {
    const discovered = await discoverFiles(FIXTURE_ROOT);
    await indexRepository(repositoryId, discovered);
    const { scanId } = await seedScan(db, repositoryId, {
      files: discovered.map((f) => ({ path: f.path, language: f.language, loc: f.loc })),
      findings: [
        { filePath: 'src/routes/auth.js', severity: 'critical', title: 'weak hash' },
        { filePath: 'src/routes/auth.js', severity: 'high', title: 'alg none' },
        { filePath: 'src/lib/config.js', severity: 'critical', title: 'hardcoded secret' },
      ],
    });
    return rebuildComponents(repositoryId, scanId);
  }

  it('produces far fewer components than files', async () => {
    const summaries = await indexAndBuild();
    const fileCount = summaries.reduce((sum, c) => sum + c.fileCount, 0);
    expect(summaries.length).toBeGreaterThan(1);
    expect(summaries.length).toBeLessThan(fileCount);
  });

  it('derives dependencies from real import edges', async () => {
    const summaries = await indexAndBuild();
    const routes = summaries.find((c) => c.key === 'routes');
    const lib = summaries.find((c) => c.key === 'lib');

    // routes/auth.js imports lib/config.js and auth/session.js — both real.
    expect(routes?.dependencyCount).toBeGreaterThan(0);
    // lib/config.js is imported by several components.
    expect(lib?.dependentCount).toBeGreaterThan(0);
  });

  it('attributes findings to the component that owns the file', async () => {
    const summaries = await indexAndBuild();
    const routes = summaries.find((c) => c.key === 'routes');
    expect(routes?.findingCount).toBe(2);
    expect(routes?.criticalCount).toBe(1);

    const lib = summaries.find((c) => c.key === 'lib');
    expect(lib?.criticalCount).toBe(1);
  });

  it('flags security-sensitive components but not the tests that cover them', async () => {
    const summaries = await indexAndBuild();
    expect(summaries.find((c) => c.key === 'auth')?.securitySensitive).toBe(true);
    expect(summaries.find((c) => c.key === 'tests')?.securitySensitive).toBe(false);
  });

  it('counts untested files from TESTS edges', async () => {
    const summaries = await indexAndBuild();
    const services = summaries.find((c) => c.key === 'services');
    // payment-service.js is deliberately untested in the fixture.
    expect(services?.untestedFiles).toBeGreaterThan(0);
  });

  it('returns components ordered by risk, highest first', async () => {
    const summaries = await indexAndBuild();
    const scores = summaries.map((c) => c.riskScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('replaces rows rather than accumulating them across rebuilds', async () => {
    await indexAndBuild();
    const first = await db.select().from(componentsTable).where(eq(componentsTable.repositoryId, repositoryId));
    await indexAndBuild();
    const second = await db.select().from(componentsTable).where(eq(componentsTable.repositoryId, repositoryId));
    expect(second.length).toBe(first.length);
  });

  it('builds a component graph whose edges reference real nodes', async () => {
    await indexAndBuild();
    const graph = await componentGraph(repositoryId);
    const keys = new Set(graph.nodes.map((n) => n.key));

    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(keys.has(edge.from)).toBe(true);
      expect(keys.has(edge.to)).toBe(true);
      // No self-loops: a component importing itself is not a dependency.
      expect(edge.from).not.toBe(edge.to);
      expect(edge.fileCount).toBeGreaterThan(0);
    }
  });

  it('returns nothing rather than inventing components when no scan exists', async () => {
    const summaries = await rebuildComponents(repositoryId);
    expect(summaries).toEqual([]);
  });
});
