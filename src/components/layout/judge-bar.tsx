'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

const LINKS = [
  { href: '/', label: 'Health' },
  { href: '/guardian', label: 'Guardian' },
  { href: '/analysis', label: 'Findings' },
  { href: '/codebase', label: 'Impact' },
  { href: '/testing', label: 'Tests' },
  { href: '/fixes', label: 'Fix' },
  { href: '/insights', label: 'Insights' },
] as const;

/**
 * Optional judge strip. Enabled with ?judge=1 (remembered in sessionStorage).
 * Only navigation — no fabricated scores.
 */
export function JudgeBar({ isDemo }: { isDemo?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [on, setOn] = React.useState(false);

  React.useEffect(() => {
    if (search.get('judge') === '1') {
      sessionStorage.setItem('cs_judge', '1');
      setOn(true);
    } else if (search.get('judge') === '0') {
      sessionStorage.removeItem('cs_judge');
      setOn(false);
    } else {
      setOn(sessionStorage.getItem('cs_judge') === '1');
    }
  }, [search]);

  if (!on) return null;

  return (
    <div className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 px-4 py-2 sm:px-8">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="font-medium">Judge path</span>
        {isDemo ? <span className="text-[hsl(var(--muted-foreground))]">Demo fixture</span> : null}
        <nav aria-label="Judge shortcuts" className="flex flex-wrap gap-3">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                pathname === link.href
                  ? 'font-medium text-[hsl(var(--foreground))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
