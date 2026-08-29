import type { Category, Severity } from '@/db/schema';






export interface TriageFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly filePath: string | null;
  readonly ruleId: string;
}

export interface FindingGroup {
  readonly key: string;
  readonly title: string;
  readonly severity: Severity;
  readonly findings: readonly TriageFinding[];
}

const AREA: Array<{ key: string; title: string; test: (f: TriageFinding) => boolean }> = [
  {
    key: 'auth',
    title: 'Authentication and authorization',
    test: (f) => /auth|session|login|permission|csrf/i.test(`${f.filePath ?? ''} ${f.ruleId} ${f.title}`),
  },
  {
    key: 'secrets',
    title: 'Committed credentials',
    test: (f) => f.category === 'secrets',
  },
  {
    key: 'injection',
    title: 'Injection and unsafe execution',
    test: (f) => /inject|eval|exec|command|sql|xss/i.test(`${f.ruleId} ${f.title}`),
  },
  {
    key: 'dependencies',
    title: 'Dependency risk',
    test: (f) => f.category === 'dependencies',
  },
  {
    key: 'tests',
    title: 'Testing gaps',
    test: (f) => f.category === 'testing',
  },
  {
    key: 'infra',
    title: 'Infrastructure and CI',
    test: (f) => f.category === 'infrastructure' || /workflow|docker|cicd|config\//i.test(f.ruleId),
  },
];

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function groupFindings(findings: readonly TriageFinding[]): FindingGroup[] {
  const buckets = new Map<string, TriageFinding[]>();
  const leftover: TriageFinding[] = [];

  for (const finding of findings) {
    const area = AREA.find((a) => a.test(finding));
    if (!area) {
      leftover.push(finding);
      continue;
    }
    const list = buckets.get(area.key) ?? [];
    list.push(finding);
    buckets.set(area.key, list);
  }

  const groups: FindingGroup[] = [];
  for (const area of AREA) {
    const list = buckets.get(area.key);
    if (!list || list.length === 0) continue;
    groups.push({
      key: area.key,
      title: area.title,
      severity: worst(list),
      findings: list,
    });
  }

  for (const finding of leftover) {
    groups.push({
      key: `solo:${finding.id}`,
      title: finding.title,
      severity: finding.severity,
      findings: [finding],
    });
  }

  return groups.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.findings.length - a.findings.length);
}

function worst(list: readonly TriageFinding[]): Severity {
  return list.reduce<Severity>((w, f) => (RANK[f.severity] < RANK[w] ? f.severity : w), 'info');
}
