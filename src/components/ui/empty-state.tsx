import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}






export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[hsl(var(--border-strong))] px-6 py-14 text-center',
        className,
      )}
    >
      {Icon ? (
        <div className="flex size-11 items-center justify-center rounded-full bg-[hsl(var(--muted))]">
          <Icon className="size-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-md text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
