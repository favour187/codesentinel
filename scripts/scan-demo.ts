







import { and, eq } from 'drizzle-orm';

import { db as getDb } from '@/db';
import { codeEdges, indexState, repositories, symbols } from '@/db/schema';
import { demoFixturePath, DEMO_REPO_FULL_NAME } from '@/lib/demo/fixture';
import { executeScan } from '@/scanner/persistence';

async function main(): Promise<void> {
  const db = await getDb();
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.fullName, DEMO_REPO_FULL_NAME))
    .limit(1);

  if (!repo) {
    throw new Error(`Demo repository not found. Run: npm run db:seed`);
  }

  const executed = await executeScan({
    repositoryId: repo.id,
    rootDir: demoFixturePath(),
    trigger: 'manual',
  });

  const { result } = executed;
  console.log('\n=== SCAN ===');
  console.log('files scanned  :', result.stats.fileCount);
  console.log('lines scanned  :', result.stats.totalLoc);
  console.log('findings       :', result.findings.length);
  console.log('severity       :', JSON.stringify(result.severityCounts));
  console.log('health         :', result.scores.health);
  console.log('  security     :', result.scores.security);
  console.log('  reliability  :', result.scores.reliability);
  console.log('  quality      :', result.scores.quality);
  console.log('  testing      :', result.scores.testing);
  console.log('  performance  :', result.scores.performance);

  const symbolRows = await db.select().from(symbols).where(eq(symbols.repositoryId, repo.id));
  const edgeRows = await db.select().from(codeEdges).where(eq(codeEdges.repositoryId, repo.id));
  const stateRows = await db.select().from(indexState).where(eq(indexState.repositoryId, repo.id));

  console.log('\n=== DIGITAL TWIN ===');
  console.log('indexed files  :', stateRows.length);
  console.log('symbols        :', symbolRows.length);
  console.log('edges          :', edgeRows.length);

  const byType = new Map<string, number>();
  for (const edge of edgeRows) byType.set(edge.type, (byType.get(edge.type) ?? 0) + 1);
  for (const [type, count] of [...byType].sort()) console.log(`  ${type.padEnd(14)}:`, count);

  console.log('\n=== IMPORTS / DEPENDS_ON EDGES ===');
  for (const edge of edgeRows.filter((e) => e.type === 'imports' || e.type === 'depends_on').sort((a, b) => a.fromKey.localeCompare(b.fromKey))) {
    console.log(`  ${edge.fromKey}  ->  ${edge.toKey}  [${edge.confidence}]`);
  }

  console.log('\n=== TESTS / EXPOSES_API / USES_DATABASE / CALLS ===');
  for (const edge of edgeRows.filter((e) => ['tests', 'exposes_api', 'uses_database', 'calls'].includes(e.type)).sort((a, b) => a.type.localeCompare(b.type))) {
    console.log(`  [${edge.type}] ${edge.fromKey} -> ${edge.toKey} (${edge.confidence}) ${edge.evidence ?? ''}`);
  }

  const { componentGraph } = await import('@/twin/components');
  const graph = await componentGraph(repo.id);
  console.log('\n=== COMPONENTS ===');
  for (const n of graph.nodes) {
    console.log(
      `  ${n.key.padEnd(18)} ${n.layer.padEnd(14)} files=${String(n.fileCount).padEnd(3)} deps=${String(n.dependencyCount).padEnd(2)} dependents=${String(n.dependentCount).padEnd(2)} findings=${String(n.findingCount).padEnd(3)} untested=${String(n.untestedFiles).padEnd(2)} sec=${n.securitySensitive ? 'Y' : 'n'} risk=${n.riskScore} (${n.riskLevel})`,
    );
  }
  console.log('\n=== COMPONENT EDGES ===');
  for (const e of graph.edges) console.log(`  ${e.from} -> ${e.to} (${e.fileCount} file imports)`);

  console.log('\n=== RISK FACTORS (top component) ===');
  const top = graph.nodes[0];
  if (top) {
    console.log(`  ${top.name} — ${top.riskScore} (${top.riskLevel})`);
    for (const f of top.riskFactors) console.log(`    +${f.points}  ${f.label}: ${f.detail}`);
  }

  const untouched = await db
    .select()
    .from(codeEdges)
    .where(and(eq(codeEdges.repositoryId, repo.id), eq(codeEdges.type, 'imports')));
  console.log('\nimports edge count (re-query):', untouched.length);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
