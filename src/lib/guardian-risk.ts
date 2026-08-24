import { and, eq, sql } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { components, findings, regressionMemory } from '@/db/schema';
import { getLatestSnapshot } from '@/lib/analysis-queries';
import { getDependencyInventory } from '@/lib/codebase-queries';
import { getTestIntelligence } from '@/testing/gaps';
import { assessRepositoryRisk, type RepoRiskResult } from '@/guardian/repo-risk';
import { findAttackPaths, type AttackPath } from '@/guardian/attack-path';
import { TwinGraph } from '@/twin/graph';
import { buildRecommendations, type Recommendation } from '@/guardian/recommendations';
import { listEvents, type GuardianEventRecord } from '@/guardian/events';

export async function getRepositoryRisk(repositoryId: string): Promise<RepoRiskResult> {
  const [snapshot, intel, inventory, db] = await Promise.all([
    getLatestSnapshot(repositoryId),
    getTestIntelligence(repositoryId),
    getDependencyInventory(repositoryId),
    getDb(),
  ]);

  const [secretRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(eq(findings.repositoryId, repositoryId), eq(findings.status, 'open'), eq(findings.category, 'secrets')));

  const componentRows = await db.select().from(components).where(eq(components.repositoryId, repositoryId));
  const [regRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(regressionMemory)
    .where(eq(regressionMemory.repositoryId, repositoryId));

  return assessRepositoryRisk({
    health: snapshot?.health ?? null,
    counts: snapshot?.counts ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    secretCount: secretRow?.n ?? 0,
    sourceFileCount: intel.sourceFileCount,
    untestedFileCount: intel.untestedFiles.length,
    vulnerablePackages: inventory.vulnerable,
    highRiskComponents: componentRows.filter((c) => c.riskLevel === 'high' || c.riskLevel === 'critical').length,
    sensitiveComponents: componentRows.filter((c) => c.securitySensitive).length,
    recentRegressions: regRow?.n ?? 0,
  });
}

export async function getGuardianSignals(repositoryId: string): Promise<{
  risk: RepoRiskResult;
  recommendations: Recommendation[];
  events: GuardianEventRecord[];
  attackPaths: AttackPath[];
  scanId: string | null;
}> {
  const [risk, intel, inventory, events, scanId, graph, db] = await Promise.all([
    getRepositoryRisk(repositoryId),
    getTestIntelligence(repositoryId),
    getDependencyInventory(repositoryId),
    listEvents(repositoryId, 25),
    latestScanId(repositoryId),
    TwinGraph.load(repositoryId),
    getDb(),
  ]);

  const openFindings = await db
    .select({ id: findings.id, filePath: findings.filePath })
    .from(findings)
    .where(and(eq(findings.repositoryId, repositoryId), eq(findings.status, 'open')));

  const componentRows = await db.select().from(components).where(eq(components.repositoryId, repositoryId));

  return {
    risk,
    recommendations: buildRecommendations({
      secretCount: risk.factors.find((f) => f.id === 'secrets') ? 1 : 0,
      untestedFileCount: intel.untestedFiles.length,
      sourceFileCount: intel.sourceFileCount,
      vulnerablePackages: inventory.vulnerable,
      highRiskComponents: componentRows
        .filter((c) => c.riskLevel === 'high' || c.riskLevel === 'critical')
        .map((c) => ({
          name: c.name,
          untestedFiles: c.untestedFiles,
          changeFrequency: c.changeFrequency,
        })),
      recentRegressions: risk.factors.find((f) => f.id === 'regression') ? 1 : 0,
      riskFactors: risk.factors,
    }),
    events,
    attackPaths: findAttackPaths(graph.edges, openFindings),
    scanId,
  };
}
