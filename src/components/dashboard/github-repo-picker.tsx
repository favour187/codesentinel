'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RemoteRepo {
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  description: string | null;
}

export function GitHubRepoPicker() {
  const router = useRouter();
  const [repos, setRepos] = React.useState<RemoteRepo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch('/api/repositories/github');
    const body = (await res.json()) as { ok?: boolean; error?: string; repositories?: RemoteRepo[] };
    if (!res.ok || !body.ok) {
      setError(body.error ?? 'Could not list repositories.');
      setRepos([]);
      return;
    }
    setRepos(body.repositories ?? []);
  }

  React.useEffect(() => {
    void load();
  }, []);

  async function connect(repo: RemoteRepo) {
    setBusy(repo.fullName);
    setError(null);
    try {
      const res = await fetch('/api/repositories/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: repo.owner, name: repo.name }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Connect failed');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed');
    } finally {
      setBusy(null);
    }
  }

  if (repos === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading your GitHub repositories…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-[hsl(var(--critical))]">
          {error}
        </p>
      ) : null}
      {repos.length === 0 && !error ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">No repositories returned for this account.</p>
      ) : (
        <ul className="divide-y divide-[hsl(var(--border))]">
          {repos.map((repo) => (
            <li key={repo.fullName} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{repo.fullName}</p>
                {repo.description ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-[hsl(var(--muted-foreground))]">{repo.description}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full shrink-0 sm:w-auto"
                onClick={() => void connect(repo)}
                disabled={busy !== null}
              >
                {busy === repo.fullName ? <Loader2 className="size-4 animate-spin" /> : null}
                Connect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
