import { headers } from 'next/headers';
import { GitHubIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { getFeatures } from '@/lib/env';

const FLOW = ['Code', 'Analyze', 'Understand', 'Protect', 'Verify'] as const;

export async function Landing({ error }: { error?: string | null }) {
  const features = getFeatures();
  const headerStore = await headers();
  const host = headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? 'localhost:3000';
  const proto = headerStore.get('x-forwarded-proto') ?? (host.includes('localhost') ? 'http' : 'https');
  const origin = `${proto}://${host.split(',')[0]?.trim()}`;
  const callback = `${origin}/api/auth/github/callback`;

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" width={32} height={32} className="size-8 rounded-lg" />
          <span className="text-sm font-semibold tracking-tight">CodeSentinel</span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8">
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight sm:text-4xl md:text-5xl">
          Your repository&rsquo;s autonomous code guardian.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-[hsl(var(--muted-foreground))]">
          Watches a GitHub repo, finds real issues in the code, and never changes anything
          unless you approve it.
        </p>

        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-[hsl(var(--critical))]/25 bg-[hsl(var(--critical))]/[0.07] px-4 py-3 text-sm text-[hsl(var(--critical))]"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <form action="/api/auth/demo" method="post">
            <Button type="submit" size="lg" className="w-full sm:w-auto">
              Explore Demo
            </Button>
          </form>
          {features.githubOAuth ? (
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <a href="/api/auth/github">
                <GitHubIcon className="size-4" />
                Connect GitHub
              </a>
            </Button>
          ) : null}
        </div>

        <ol className="mt-12 flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
          {FLOW.map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="rounded-full border border-[hsl(var(--border))] px-3 py-1 text-[hsl(var(--foreground))]">
                {step}
              </span>
              {i < FLOW.length - 1 ? <span aria-hidden="true">→</span> : null}
            </li>
          ))}
        </ol>

        <section className="mt-14 rounded-xl border border-[hsl(var(--border))] p-6">
          <h2 className="text-sm font-semibold">Connect GitHub</h2>
          {features.githubOAuth ? (
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              Click <strong>Connect GitHub</strong>, approve access, then pick a repository on Overview.
              Callback already matches this host.
            </p>
          ) : (
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              <p>OAuth is not configured on this instance yet. Create a GitHub OAuth App:</p>
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  GitHub → Settings → Developer settings →{' '}
                  <a
                    className="underline underline-offset-4"
                    href="https://github.com/settings/developers"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OAuth Apps
                  </a>{' '}
                  → New.
                </li>
                <li>
                  Homepage URL:{' '}
                  <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-xs">{origin}</code>
                </li>
                <li>
                  Authorization callback URL:{' '}
                  <code className="break-all rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-xs">
                    {callback}
                  </code>
                </li>
                <li>
                  Put the Client ID and Secret in <code className="font-mono text-xs">.env.local</code> as{' '}
                  <code className="font-mono text-xs">GITHUB_CLIENT_ID</code> and{' '}
                  <code className="font-mono text-xs">GITHUB_CLIENT_SECRET</code>, then restart.
                </li>
              </ol>
              <p>Until then, use Explore Demo — it does not need GitHub.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
