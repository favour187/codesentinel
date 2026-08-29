import { Brain, CircleHelp, Lightbulb, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';











export type Confidence = 'high' | 'medium' | 'low';
export type ClaimKind = 'FACT' | 'INFERENCE' | 'RECOMMENDATION';

const CLAIM_META: Record<ClaimKind, { label: string; icon: typeof ShieldCheck; className: string; title: string }> = {
  FACT: {
    label: 'Fact',
    icon: ShieldCheck,
    className: 'text-[hsl(var(--success))]',
    title: 'Read directly from deterministic scan data',
  },
  INFERENCE: {
    label: 'Inference',
    icon: Brain,
    className: 'text-[hsl(var(--low))]',
    title: 'Reasoned from the evidence — could be wrong',
  },
  RECOMMENDATION: {
    label: 'Recommendation',
    icon: Lightbulb,
    className: 'text-[hsl(var(--medium))]',
    title: 'A suggested action, not a statement about your code',
  },
};

const CONFIDENCE_VARIANT: Record<Confidence, 'success' | 'medium' | 'outline'> = {
  high: 'success',
  medium: 'medium',
  low: 'outline',
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <Badge variant={CONFIDENCE_VARIANT[confidence]} title="How confident the model is, given the evidence it was shown">
      {confidence} confidence
    </Badge>
  );
}

export function ClaimList({ claims }: { claims: ReadonlyArray<{ kind: ClaimKind; text: string }> }) {
  if (claims.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        Claims, labelled by basis
      </p>
      <ul className="space-y-2">
        {claims.map((claim, i) => {
          const meta = CLAIM_META[claim.kind] ?? CLAIM_META.INFERENCE;
          const Icon = meta.icon;
          return (
            <li key={`${claim.kind}-${i}`} className="flex items-start gap-2.5 text-sm">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', meta.className)} aria-hidden="true" />
              <span>
                <span className={cn('font-medium', meta.className)} title={meta.title}>
                  {meta.label}:
                </span>{' '}
                <span className="text-[hsl(var(--muted-foreground))]">{claim.text}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}








export function AIDisclosure({
  confidence,
  provider,
  model,
  evidenceCount,
  className,
}: {
  confidence?: Confidence;
  provider?: string;
  model?: string;
  evidenceCount?: number;
  className?: string;
}) {
  const parts = [
    provider && model ? `${provider} · ${model}` : provider || model || null,
    evidenceCount !== undefined ? `${evidenceCount} source${evidenceCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t border-[hsl(var(--border))] pt-3 text-xs text-[hsl(var(--muted-foreground))]',
        className,
      )}
    >
      <CircleHelp className="size-3.5" aria-hidden="true" />
      <span>AI-generated from your repository. Verify before acting.</span>
      {confidence ? <ConfidenceBadge confidence={confidence} /> : null}
      {parts.length > 0 ? <span className="w-full break-all font-mono sm:ml-auto sm:w-auto">{parts.join(' · ')}</span> : null}
    </div>
  );
}








export function AIUnavailableNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-[hsl(var(--border-strong))] p-4 text-sm text-[hsl(var(--muted-foreground))]',
        className,
      )}
    >
      <p className="font-medium text-[hsl(var(--foreground))]">AI features are not configured</p>
      <p className="mt-1 leading-relaxed">
        Add a <code className="font-mono text-xs">FEATHERLESS_API_KEY</code> or{' '}
        <code className="font-mono text-xs">GROQ_API_KEY</code> to enable explanations, fixes and codebase questions.
        All scanning, findings and scores continue to work without it.
      </p>
    </div>
  );
}
