import type { GraphEdge } from '@/twin/graph';
import { fileOfKey, isRouteKey, isDatabaseKey, labelOfKey } from '@/twin/graph';















export type AttackConfidence = 'confirmed' | 'likely' | 'potential';

export interface AttackPath {
  readonly hops: readonly string[];
  readonly confidence: AttackConfidence;
  readonly evidence: string;
  readonly findingIds: readonly string[];
}

export interface AttackFinding {
  readonly id: string;
  readonly filePath: string | null;
}

const AUTH_PATH = /(^|\/)(auth|session|login|permission|token|admin)/i;

export function findAttackPaths(
  edges: readonly GraphEdge[],
  findings: readonly AttackFinding[],
  options: { limit?: number } = {},
): AttackPath[] {
  const limit = options.limit ?? 20;
  const outgoing = new Map<string, string[]>();
  const routes: string[] = [];
  const databases = new Set<string>();

  for (const edge of edges) {
    if (edge.type === 'exposes_api' && isRouteKey(edge.toKey)) {
      const file = fileOfKey(edge.fromKey);
      if (file) routes.push(file);
    }
    if (edge.type === 'uses_database' && isDatabaseKey(edge.toKey)) {
      const file = fileOfKey(edge.fromKey);
      if (file) databases.add(file);
    }
    if (edge.type !== 'imports' && edge.type !== 'calls') continue;
    const from = fileOfKey(edge.fromKey);
    const to = fileOfKey(edge.toKey);
    if (!from || !to || from === to) continue;
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  }

  const findingsByFile = new Map<string, string[]>();
  for (const finding of findings) {
    if (!finding.filePath) continue;
    const list = findingsByFile.get(finding.filePath) ?? [];
    list.push(finding.id);
    findingsByFile.set(finding.filePath, list);
  }

  const paths: AttackPath[] = [];
  const seen = new Set<string>();

  for (const start of [...new Set(routes)]) {
    const queue: Array<{ node: string; hops: string[] }> = [{ node: start, hops: [start] }];
    const visited = new Set<string>([start]);

    while (queue.length > 0 && paths.length < limit) {
      const current = queue.shift();
      if (!current || current.hops.length > 5) continue;

      const isSensitive = databases.has(current.node) || AUTH_PATH.test(current.node);
      if (isSensitive && current.hops.length > 1) {
        const key = current.hops.join('>');
        if (!seen.has(key)) {
          seen.add(key);
          paths.push(scorePath(current.hops, findingsByFile));
        }
      }

      for (const next of outgoing.get(current.node) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ node: next, hops: [...current.hops, next] });
      }
    }
  }

  const order = { confirmed: 0, likely: 1, potential: 2 } as const;
  return paths.sort((a, b) => order[a.confidence] - order[b.confidence]).slice(0, limit);
}

function scorePath(hops: readonly string[], findingsByFile: Map<string, string[]>): AttackPath {
  const onPath: string[] = [];
  for (const hop of hops) onPath.push(...(findingsByFile.get(hop) ?? []));

  let confidence: AttackConfidence = 'potential';
  let evidence = `Static path ${hops.join(' → ')} reaches a sensitive sink. No finding sits on this path.`;

  if (onPath.length > 0) {
    confidence = 'confirmed';
    evidence = `${onPath.length} finding${onPath.length === 1 ? '' : 's'} sit on this path. That is a relationship, not a proof of compromise.`;
  } else {
    const neighbors = hops.flatMap((h) => [...(findingsByFile.keys())].filter((f) => f !== h && f.startsWith(h.split('/')[0] ?? '')));
    if (neighbors.length > 0) {
      confidence = 'likely';
      evidence = 'A complete path exists and related files in the same tree have findings.';
    }
  }

  return {
    hops: hops.map((h) => (h.startsWith('api:') ? labelOfKey(h) : h)),
    confidence,
    evidence,
    findingIds: onPath,
  };
}
