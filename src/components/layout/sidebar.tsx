'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Menu, X, ShieldCheck } from 'lucide-react';
import { NAV_ITEMS } from './nav-config';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface SidebarProps {
  repoLabel?: string;
  isDemo?: boolean;
}

/**
 * Navigation is split into two components on purpose.
 *
 * `Sidebar` is the desktop rail and `MobileNav` is the trigger + drawer. An
 * earlier version rendered one component in both slots, which mounted two
 * hamburger buttons and two `<nav aria-label="Main navigation">` landmarks —
 * a visible stray button on mobile and an ambiguous landmark for screen
 * readers. Each element now has exactly one instance in the tree.
 */

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors lg:min-h-0 lg:py-2',
              active
                ? 'bg-[hsl(var(--muted))] font-medium text-[hsl(var(--foreground))]'
                : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]/60 hover:text-[hsl(var(--foreground))]',
            )}
          >
            <item.icon
              className={cn('size-4 shrink-0', active ? 'text-[hsl(var(--primary))]' : '')}
              aria-hidden="true"
            />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ repoLabel }: { repoLabel?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-6 py-5">
      <div className="flex size-7 items-center justify-center rounded-md bg-[hsl(var(--primary))]">
        <ShieldCheck className="size-4 text-[hsl(var(--primary-foreground))]" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-none tracking-tight">CodeSentinel</p>
        {repoLabel ? (
          <p className="mt-1 truncate text-xs text-[hsl(var(--muted-foreground))]">{repoLabel}</p>
        ) : null}
      </div>
    </div>
  );
}

function DemoFooter({ isDemo }: { isDemo?: boolean }) {
  if (!isDemo) return null;
  return (
    <div className="mx-3 mb-4 rounded-lg border border-[hsl(var(--medium))]/25 bg-[hsl(var(--medium))]/[0.07] px-3 py-2.5">
      <p className="text-xs font-medium text-[hsl(var(--medium))]">Demo workspace</p>
      <p className="mt-1 text-[11px] leading-relaxed text-[hsl(var(--muted-foreground))]">
        Results come from a real scan of the bundled vulnerable fixture — not a production repository.
      </p>
    </div>
  );
}

/** Desktop navigation rail. Hidden below the `lg` breakpoint. */
export function Sidebar({ repoLabel, isDemo }: SidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--surface))] lg:flex">
      <Brand repoLabel={repoLabel} />
      <NavLinks />
      <DemoFooter isDemo={isDemo} />
    </aside>
  );
}

/** Mobile trigger + off-canvas drawer. Hidden at `lg` and above. */
export function MobileNav({ repoLabel, isDemo }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close on route change so the drawer never covers the new page.
  React.useEffect(() => setOpen(false), [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The trigger lives inside a `backdrop-blur` header, which establishes a
  // containing block for fixed-position descendants. Rendering the drawer in
  // place clipped it to the 55px header instead of the viewport, so it is
  // portalled to <body>.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const drawer = open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="animate-in-fade absolute inset-y-0 left-0 flex w-[264px] flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
            <div className="flex items-center justify-between pr-3">
              <Brand repoLabel={repoLabel} />
              <Button variant="ghost" size="icon-sm" aria-label="Close navigation" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <DemoFooter isDemo={isDemo} />
          </aside>
        </div>
  ) : null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu className="size-4" />
      </Button>

      {mounted && drawer ? createPortal(drawer, document.body) : null}
    </>
  );
}
