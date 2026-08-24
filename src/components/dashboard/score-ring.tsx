import { cn } from '@/lib/utils';

interface ScoreRingProps {
  score: number;
  label: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/** Score → semantic colour. Shared by every score surface. */
export function scoreTone(score: number): { color: string; label: string } {
  if (score >= 90) return { color: 'var(--success)', label: 'Excellent' };
  if (score >= 75) return { color: 'var(--low)', label: 'Good' };
  if (score >= 60) return { color: 'var(--medium)', label: 'Fair' };
  if (score >= 40) return { color: 'var(--high)', label: 'At risk' };
  return { color: 'var(--critical)', label: 'Critical' };
}

/**
 * Primary health indicator. Inline SVG (no chart library) so it renders in the
 * sandboxed preview and costs nothing in bundle size.
 */
export function ScoreRing({ score, label, size = 148, strokeWidth = 10, className }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, score));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const tone = scoreTone(clamped);

  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${Math.round(clamped)} out of 100 — ${tone.label}`}
          className="-rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={`hsl(${tone.color})`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-semibold tabular-nums tracking-tight">{Math.round(clamped)}</span>
          <span className="text-xs text-[hsl(var(--muted-foreground))]">out of 100</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs" style={{ color: `hsl(${tone.color})` }}>
          {tone.label}
        </p>
      </div>
    </div>
  );
}

interface ScoreBarProps {
  label: string;
  score: number;
  detail?: string;
}

/** Compact sub-score row used beside the main ring. */
export function ScoreBar({ label, score, detail }: ScoreBarProps) {
  const clamped = Math.max(0, Math.min(100, score));
  const tone = scoreTone(clamped);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className="text-sm font-medium tabular-nums">{Math.round(clamped)}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--muted))]"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${clamped}%`, backgroundColor: `hsl(${tone.color})` }}
        />
      </div>
      {detail ? <p className="text-xs text-[hsl(var(--muted-foreground))]">{detail}</p> : null}
    </div>
  );
}
