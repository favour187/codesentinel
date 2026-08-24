import type { Severity } from '@/db/schema';

export interface DepSnapshot {
  readonly name: string;
  readonly ecosystem: string;
  readonly version: string | null;
  readonly vulnerabilities: ReadonlyArray<{ id: string; severity: Severity }>;
}

export type DepChangeKind = 'added' | 'removed' | 'updated';

export interface DependencyChange {
  readonly kind: DepChangeKind;
  readonly name: string;
  readonly ecosystem: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly risk: 'low' | 'medium' | 'high';
  readonly reason: string;
}

export function diffDependencies(
  previous: readonly DepSnapshot[],
  current: readonly DepSnapshot[],
): DependencyChange[] {
  const prev = new Map(previous.map((d) => [`${d.ecosystem}:${d.name}`, d]));
  const next = new Map(current.map((d) => [`${d.ecosystem}:${d.name}`, d]));
  const changes: DependencyChange[] = [];

  for (const [key, dep] of next) {
    const old = prev.get(key);
    if (!old) {
      const vulns = dep.vulnerabilities.length;
      changes.push({
        kind: 'added',
        name: dep.name,
        ecosystem: dep.ecosystem,
        from: null,
        to: dep.version,
        risk: vulns > 0 ? 'high' : 'medium',
        reason: vulns > 0 ? `New package with ${vulns} published advisory(ies)` : 'New direct dependency',
      });
      continue;
    }
    if ((old.version ?? '') !== (dep.version ?? '')) {
      const vulns = dep.vulnerabilities.length;
      changes.push({
        kind: 'updated',
        name: dep.name,
        ecosystem: dep.ecosystem,
        from: old.version,
        to: dep.version,
        risk: vulns > 0 ? 'high' : 'low',
        reason: vulns > 0 ? 'Version change still carries published advisories' : 'Version change with no known advisory',
      });
    }
  }

  for (const [key, dep] of prev) {
    if (next.has(key)) continue;
    changes.push({
      kind: 'removed',
      name: dep.name,
      ecosystem: dep.ecosystem,
      from: dep.version,
      to: null,
      risk: 'low',
      reason: 'Dependency removed',
    });
  }

  return changes.sort((a, b) => a.name.localeCompare(b.name));
}
