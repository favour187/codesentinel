import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/icons';
import { Sidebar, MobileNav } from './sidebar';
import { ThemeToggle } from './theme-toggle';
import { JudgeBar } from './judge-bar';
import { Button } from '@/components/ui/button';
import { Suspense } from 'react';
import type { CurrentUser } from '@/lib/auth/current-user';

interface AppShellProps {
  user: CurrentUser;
  repoLabel?: string;
  children: React.ReactNode;
}






export function AppShell({ user, repoLabel, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      <Sidebar repoLabel={repoLabel} isDemo={user.isDemo} />

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))]/85 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md sm:px-8">
          <MobileNav repoLabel={repoLabel} isDemo={user.isDemo} />

          <p className="min-w-0 truncate text-sm font-medium lg:hidden">{repoLabel ?? 'CodeSentinel'}</p>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <ThemeToggle />

            <div className="hidden items-center gap-2.5 border-l border-[hsl(var(--border))] pl-3 sm:flex">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatarUrl}
                  alt=""
                  width={24}
                  height={24}
                  className="size-6 rounded-full border border-[hsl(var(--border))]"
                />
              ) : (
                <div className="flex size-6 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[10px] font-semibold uppercase">
                  {user.login.slice(0, 2)}
                </div>
              )}
              <span className="text-sm text-[hsl(var(--muted-foreground))]">{user.login}</span>
            </div>

            {user.isDemo ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/login">
                  <GitHubIcon className="size-3.5" />
                  Connect GitHub
                </Link>
              </Button>
            ) : null}

            <form action="/api/auth/logout" method="post">
              <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out">
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </header>

        <Suspense fallback={null}>
          <JudgeBar isDemo={user.isDemo} />
        </Suspense>

        <main id="main" className="mx-auto w-full min-w-0 max-w-[1280px] px-3 py-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-8 sm:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
