import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PhasePlaceholderProps {
  icon: LucideIcon;
  title: string;
  phase: string;
  description: string;
  capabilities: string[];
}

/**
 * Honest "not built yet" surface for sections scheduled in a later phase.
 *
 * This is intentionally NOT fake data: it states plainly what the section will
 * contain and which build phase delivers it, so nobody mistakes a placeholder
 * for a working scanner result.
 */
export function PhasePlaceholder({ icon: Icon, title, phase, description, capabilities }: PhasePlaceholderProps) {
  return (
    <Card className="border-dashed">
      <div className="flex flex-col gap-6 p-8 sm:flex-row sm:gap-8">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--muted))]">
          <Icon className="size-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            <Badge variant="outline">Arrives in {phase}</Badge>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">{description}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {capabilities.map((c) => (
              <li key={c} className="flex items-start gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                <span
                  className="mt-[0.4rem] size-1 shrink-0 rounded-full bg-[hsl(var(--border-strong))]"
                  aria-hidden="true"
                />
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
