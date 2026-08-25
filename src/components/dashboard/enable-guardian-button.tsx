'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Radar } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EnableGuardianButton({ repositoryId }: { repositoryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/repositories/${repositoryId}/guardian`, { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; enabled?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Could not turn Guardian on');
      if (!body.enabled) {
        throw new Error(
          'The GitHub App is not installed on this repository yet. Open GitHub → Install App, then try again.',
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn Guardian on');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button type="button" size="sm" variant="outline" onClick={() => void enable()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Radar className="size-4" aria-hidden="true" />}
        {busy ? 'Turning on…' : 'Turn Guardian on'}
      </Button>
      {error ? (
        <p role="alert" className="max-w-xs text-xs text-[hsl(var(--critical))]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
