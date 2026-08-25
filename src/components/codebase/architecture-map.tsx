import { Badge } from '@/components/ui/badge';
import type { ComponentSummary, Layer } from '@/twin/components';
import type { RiskLevel } from '@/twin/components';

const RISK_VARIANT: Record<RiskLevel, 'critical' | 'high' | 'medium' | 'low'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export function ArchitectureMap({
  layers,
}: {
  layers: ReadonlyArray<{ layer: Layer; components: ComponentSummary[] }>;
}) {
  return (
    <div className="space-y-8">
      {layers.map((row) => (
        <div key={row.layer}>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            {row.layer}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {row.components.map((component) => (
              <article
                key={component.key}
                className="rounded-lg border border-[hsl(var(--border))] px-4 py-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <h3 className="min-w-0 text-sm font-medium">{component.name}</h3>
                  <Badge variant={RISK_VARIANT[component.riskLevel]} className="w-fit">{component.riskLevel}</Badge>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-[hsl(var(--muted-foreground))]">{component.rootPath}</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-[hsl(var(--muted-foreground))]">Files</dt>
                    <dd className="tabular-nums">{component.fileCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[hsl(var(--muted-foreground))]">Findings</dt>
                    <dd className="tabular-nums">{component.findingCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[hsl(var(--muted-foreground))]">Untested</dt>
                    <dd className="tabular-nums">{component.untestedFiles}</dd>
                  </div>
                </dl>
                {component.riskFactors[0] ? (
                  <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
                    {component.riskFactors[0].label}: {component.riskFactors[0].detail}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ComponentEdges({
  edges,
  names,
}: {
  edges: ReadonlyArray<{ from: string; to: string; fileCount: number }>;
  names: Record<string, string>;
}) {
  if (edges.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        No inter-component imports were recorded. Edges appear when one directory imports another.
      </p>
    );
  }

  const top = [...edges].sort((a, b) => b.fileCount - a.fileCount).slice(0, 24);

  return (
    <ul className="divide-y divide-[hsl(var(--border))]">
      {top.map((edge) => (
        <li key={`${edge.from}->${edge.to}`} className="flex flex-col gap-1 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="min-w-0 break-words">
            <span className="font-medium">{names[edge.from] ?? edge.from}</span>
            <span className="mx-2 text-[hsl(var(--muted-foreground))]">→</span>
            <span className="font-medium">{names[edge.to] ?? edge.to}</span>
          </span>
          <span className="shrink-0 tabular-nums text-xs text-[hsl(var(--muted-foreground))]">
            {edge.fileCount} import{edge.fileCount === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ul>
  );
}
