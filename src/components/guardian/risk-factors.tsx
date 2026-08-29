import type { RiskFactor } from '@/guardian/risk';








export function RiskFactors({ factors }: { factors: readonly RiskFactor[] }) {
  if (factors.length === 0) {
    return (
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        No risk factors — this change is small, tested and introduces no findings.
      </p>
    );
  }

  const max = Math.max(...factors.map((f) => Math.abs(f.points)), 1);

  return (
    <ul className="space-y-2.5">
      {factors.map((factor) => {
        const credit = factor.points < 0;
        return (
          <li key={factor.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1">
            <p className="text-xs font-medium">{factor.label}</p>
            <p
              className={`text-xs font-semibold tabular-nums ${
                credit ? 'text-[hsl(var(--success))]' : 'text-[hsl(var(--foreground))]'
              }`}
            >
              {credit ? '' : '+'}
              {factor.points}
            </p>
            <div className="col-span-2">
              <div
                className="h-1 rounded-full bg-[hsl(var(--muted))]"
                role="presentation"
              >
                <div
                  className={`h-1 rounded-full ${credit ? 'bg-[hsl(var(--success))]' : 'bg-[hsl(var(--high))]'}`}
                  style={{ width: `${Math.round((Math.abs(factor.points) / max) * 100)}%` }}
                />
              </div>
              {factor.detail ? (
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{factor.detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
