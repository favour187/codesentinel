import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { getFeatures } from '@/lib/env';

const FLOW = ['Code', 'Analyze', 'Understand', 'Protect', 'Verify'] as const;

export function Landing({ error }: { error?: string | null }) {
  const features = getFeatures();

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))]">
            <ShieldCheck className="size-4 text-[hsl(var(--primary-foreground))]" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold tracking-tight">CodeSentinel</span>
        </div>
        <Link href="/login" className="text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
          Sign in
        </Link>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-6 pb-24 pt-10 sm:pt-16">
        <p className="text-sm font-medium text-[hsl(var(--primary))]">Open source · GitHub-connected</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Your repository&rsquo;s autonomous code guardian.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[hsl(var(--muted-foreground))] sm:text-lg">
          CodeSentinel watches a GitHub repository, detects security and reliability risks, shows how a
          change can spread, and helps you review a fix before it reaches production. Deterministic
          scanners do the detecting. AI only explains what they found.
        </p>

        {error ? (
          <div
            role="alert"
            className="mt-6 max-w-xl rounded-lg border border-[hsl(var(--critical))]/25 bg-[hsl(var(--critical))]/[0.07] px-4 py-3 text-sm text-[hsl(var(--critical))]"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {features.githubOAuth ? (
            <Button asChild size="lg">
              <a href="/api/auth/github">
                <GitHubIcon className="size-4" />
                Connect GitHub
              </a>
            </Button>
          ) : (
            <Button asChild size="lg" variant="outline">
              <a href="/login">Connect GitHub</a>
            </Button>
          )}
          <form action="/api/auth/demo" method="post">
            <Button type="submit" size="lg" variant={features.githubOAuth ? 'outline' : 'default'}>
              Explore Demo
            </Button>
          </form>
        </div>

        <ol className="mt-16 flex flex-wrap items-center gap-3 text-sm font-medium" aria-label="How CodeSentinel works">
          {FLOW.map((step, i) => (
            <li key={step} className="flex items-center gap-3">
              <span className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--surface-raised))] px-4 py-2">
                {step}
              </span>
              {i < FLOW.length - 1 ? (
                <span className="text-[hsl(var(--muted-foreground))]" aria-hidden="true">
                  ↓
                </span>
              ) : null}
            </li>
          ))}
        </ol>

        <ul className="mt-16 grid gap-8 sm:grid-cols-3">
          <li>
            <h2 className="text-sm font-semibold">Continuous Guardian</h2>
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              Pushes and pull requests are scanned. Findings are stored. Nothing is applied to your
              code unless you approve it.
            </p>
          </li>
          <li>
            <h2 className="text-sm font-semibold">Digital twin</h2>
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              Imports, components and APIs are extracted from the repository so blast radius is
              measured, not guessed.
            </p>
          </li>
          <li>
            <h2 className="text-sm font-semibold">Grounded AI</h2>
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              Explanations cite files and findings. If every model is offline, scanners and Guardian
              still run.
            </p>
          </li>
        </ul>
      </main>
    </div>
  );
}
