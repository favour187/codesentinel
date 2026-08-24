import type { HealthSnapshotView } from '@/lib/analysis-queries';

export type Trajectory = 'improving' | 'stable' | 'degrading' | 'unknown';

export function trajectoryOf(values: readonly number[]): Trajectory {
  if (values.length < 2) return 'unknown';
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const delta = last - first;
  if (delta >= 3) return 'improving';
  if (delta <= -3) return 'degrading';
  return 'stable';
}

export function insightSeries(history: readonly HealthSnapshotView[]) {
  const chronological = [...history];
  return {
    health: trajectoryOf(chronological.map((s) => s.health)),
    security: trajectoryOf(chronological.map((s) => s.security)),
    testing: trajectoryOf(chronological.map((s) => s.testing)),
    debt: trajectoryOf(chronological.map((s) => -s.debtHours)),
  };
}
