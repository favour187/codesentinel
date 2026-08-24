import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]',
        outline: 'border-[hsl(var(--border-strong))] text-[hsl(var(--muted-foreground))]',
        critical: 'border-[hsl(var(--critical))]/25 bg-[hsl(var(--critical))]/10 text-[hsl(var(--critical))]',
        high: 'border-[hsl(var(--high))]/25 bg-[hsl(var(--high))]/10 text-[hsl(var(--high))]',
        medium: 'border-[hsl(var(--medium))]/25 bg-[hsl(var(--medium))]/10 text-[hsl(var(--medium))]',
        low: 'border-[hsl(var(--low))]/25 bg-[hsl(var(--low))]/10 text-[hsl(var(--low))]',
        info: 'border-[hsl(var(--info))]/25 bg-[hsl(var(--info))]/10 text-[hsl(var(--muted-foreground))]',
        success: 'border-[hsl(var(--success))]/25 bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]',
        primary: 'border-[hsl(var(--primary))]/25 bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
