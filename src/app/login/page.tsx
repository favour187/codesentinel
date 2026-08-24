import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShieldCheck, Lock, GitPullRequest, Boxes } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getFeatures } from '@/lib/env';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_not_configured:
    'GitHub OAuth is not configured on this instance. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or continue with the demo workspace.',
  state_mismatch: 'Sign-in verification failed (state mismatch). Please try again.',
  missing_code: 'GitHub did not return an authorisation code. Please try again.',
  oauth_start_failed: 'Could not start GitHub sign-in. Check the server logs and your OAuth configuration.',
  oauth_failed: 'We could not complete GitHub sign-in. Please try again.',
  demo_failed: 'The demo workspace could not be started. Check the server logs.',
  access_denied: 'GitHub authorisation was cancelled.',
};

const HIGHLIGHTS = [
  { icon: ShieldCheck, title: 'Deterministic scanners first', body: 'Real AST and pattern analysis of your actual code. AI explains findings — it never invents them.' },
  { icon: GitPullRequest, title: 'Guardian on every pull request', body: 'Blast-radius analysis, new vs. resolved findings, and GitHub Checks that respect your severity policy.' },
  { icon: Boxes, title: 'Repository intelligence', body: 'Import graph, architecture map, dependency vulnerabilities and test-gap detection.' },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user && !user.isDemo) redirect('/');

  const { error } = await searchParams;
  const features = getFeatures();
  const message = error ? (ERROR_MESSAGES[error] ?? 'Sign-in failed. Please try again.') : null;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Left: sign-in */}
      <div className="flex items-center justify-center px-6 py-16 sm:px-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))]">
              <ShieldCheck className="size-4.5 text-[hsl(var(--primary-foreground))]" aria-hidden="true" />
            </div>
            <span className="text-[0.9375rem] font-semibold tracking-tight">CodeSentinel</span>
          </div>

          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Your repository&rsquo;s autonomous code guardian.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            Connect a repository to continuously analyse security, reliability, dependencies, tests and
            architecture — on every push and pull request.
          </p>

          {message ? (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-[hsl(var(--critical))]/25 bg-[hsl(var(--critical))]/[0.07] px-4 py-3 text-sm text-[hsl(var(--critical))]"
            >
              {message}
            </div>
          ) : null}

          <div className="mt-8 space-y-3">
            {features.githubOAuth ? (
              <Button asChild size="lg" className="w-full">
                <a href="/api/auth/github">
                  <GitHubIcon className="size-4" />
                  Continue with GitHub
                </a>
              </Button>
            ) : (
              <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] px-4 py-3.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Lock className="size-3.5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                  GitHub sign-in not configured
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
                  Set <code className="font-mono text-[11px]">GITHUB_CLIENT_ID</code> and{' '}
                  <code className="font-mono text-[11px]">GITHUB_CLIENT_SECRET</code> in{' '}
                  <code className="font-mono text-[11px]">.env.local</code>. See{' '}
                  <span className="font-mono text-[11px]">docs/github-app-setup.md</span>.
                </p>
              </div>
            )}

            <form action="/api/auth/demo" method="post">
              <Button
                type="submit"
                variant={features.githubOAuth ? 'outline' : 'default'}
                size="lg"
                className="w-full"
              >
                Explore the demo workspace
              </Button>
            </form>
          </div>

          <p className="mt-6 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
            The demo scans a bundled, intentionally vulnerable fixture with the same real scanners. Its results
            are always labelled as demo data and never mixed with production analysis.
          </p>

          <p className="mt-8 border-t border-[hsl(var(--border))] pt-6 text-xs text-[hsl(var(--muted-foreground))]">
            Open source and free.{' '}
            <Link href="/settings" className="underline underline-offset-4 hover:text-[hsl(var(--foreground))]">
              Configuration
            </Link>
          </p>
        </div>
      </div>

      {/* Right: value panel */}
      <div className="relative hidden border-l border-[hsl(var(--border))] bg-[hsl(var(--surface))] lg:block">
        <div className="grid-noise absolute inset-0 opacity-40" aria-hidden="true" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <div className="space-y-9">
            {HIGHLIGHTS.map((h) => (
              <div key={h.title} className="flex gap-4">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-raised))]">
                  <h.icon className="size-4 text-[hsl(var(--primary))]" aria-hidden="true" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{h.title}</p>
                  <p className="max-w-sm text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">{h.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
