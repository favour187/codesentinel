'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, PlayCircle, AlertCircle } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { GitHubRepoPicker } from '@/components/dashboard/github-repo-picker';

interface ConnectRepositoryProps {
  githubConnected: boolean;
  demoAvailable: boolean;
}







export function ConnectRepository({ githubConnected, demoAvailable }: ConnectRepositoryProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<null | 'demo'>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function registerDemo() {
    setPending('demo');
    setError(null);
    try {
      const res = await fetch('/api/repositories/demo', { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Failed to register the demo repository');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <div className="space-y-6 p-5 sm:p-8 md:p-10">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">Connect a repository to begin</h2>
          <p className="text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            CodeSentinel analyses real source code. Point it at a GitHub repository, or start with the bundled
            demo fixture to see genuine detection end to end.
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[hsl(var(--critical))]/25 bg-[hsl(var(--critical))]/[0.07] px-4 py-3 text-sm text-[hsl(var(--critical))]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="space-y-3">
          {githubConnected ? (
            <div className="rounded-lg border border-[hsl(var(--border))] p-4">
              <p className="mb-3 text-sm font-medium">Your GitHub repositories</p>
              <GitHubRepoPicker />
            </div>
          ) : (
            <Button asChild size="lg" variant="outline" className="w-full justify-start">
              <a href="/api/auth/github?redirect=/">
                <GitHubIcon className="size-4" />
                Sign in with GitHub
              </a>
            </Button>
          )}

          {demoAvailable ? (
            <Button
              onClick={registerDemo}
              disabled={pending !== null}
              size="lg"
              variant="secondary"
              className="w-full justify-start"
            >
              {pending === 'demo' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <PlayCircle className="size-4" aria-hidden="true" />
              )}
              {pending === 'demo' ? 'Registering demo repository…' : 'Use the demo repository'}
            </Button>
          ) : null}
        </div>

        <p className="border-t border-[hsl(var(--border))] pt-5 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
          CodeSentinel requests read access only. Tokens are encrypted at rest with AES-256-GCM, and discovered
          secrets are fingerprinted — never stored or displayed in plaintext.
        </p>
      </div>
    </Card>
  );
}
