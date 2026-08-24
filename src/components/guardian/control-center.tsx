import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { RepoRiskResult } from '@/guardian/repo-risk';
import type { GuardianEventRecord } from '@/guardian/events';
import type { Recommendation } from '@/guardian/recommendations';
import { timeAgo } from '@/lib/utils';
import type { Severity } from '@/db/schema';

const RISK: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

export function GuardianControlCenter({
  active,
  health,
  risk,
  lastScanAt,
  events,
  recommendations,
}: {
  active: boolean;
  health: number | null;
  risk: RepoRiskResult;
  lastScanAt: Date | null;
  events: readonly GuardianEventRecord[];
  recommendations: readonly Recommendation[];
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-5">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Guardian</p>
            <p className="mt-2 text-lg font-semibold">{active ? 'Active' : 'Paused'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Repository health</p>
            <p className="mt-2 text-lg font-semibold tabular-nums">
              {health === null ? '—' : `${Math.round(health)}/100`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Current risk</p>
            <div className="mt-2">
              <Badge variant={RISK[risk.level]}>{risk.level.toUpperCase()}</Badge>
              <span className="ml-2 text-sm tabular-nums text-[hsl(var(--muted-foreground))]">{risk.score}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Last scan</p>
            <p className="mt-2 text-lg font-semibold">{lastScanAt ? timeAgo(lastScanAt) : 'Never'}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <p className="mb-3 text-sm font-semibold">Activity</p>
            {events.length === 0 ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No guardian events recorded yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {events.slice(0, 8).map((event) => (
                  <li key={event.id} className="text-sm">
                    <span className="text-[hsl(var(--muted-foreground))]">{timeAgo(event.createdAt)}</span>
                    <span className="mx-2">·</span>
                    {event.title}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="mb-3 text-sm font-semibold">Recommendations</p>
            {recommendations.length === 0 ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                No proactive recommendations from current measurements.
              </p>
            ) : (
              <ul className="space-y-3">
                {recommendations.slice(0, 5).map((rec) => (
                  <li key={rec.id}>
                    <p className="text-sm font-medium">{rec.title}</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{rec.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
