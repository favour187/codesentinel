'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Radar } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TestGuardianButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/guardian/test', { method: 'POST' });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        repository?: string;
        guardianEnabled?: boolean;
        delivery?: { status: string; message: string };
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Test failed');
      setMessage(
        `${body.repository}: ping ${body.delivery?.status ?? 'recorded'}. Guardian ${
          body.guardianEnabled ? 'on' : 'still off — install the GitHub App if it is not.'
        }`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void run()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Radar className="size-4" aria-hidden="true" />}
        {busy ? 'Sending ping…' : 'Test Guardian'}
      </Button>
      {message ? <p className="max-w-sm text-xs text-[hsl(var(--muted-foreground))]">{message}</p> : null}
      {error ? (
        <p role="alert" className="max-w-sm text-xs text-[hsl(var(--critical))]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
