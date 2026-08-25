'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ScanButton({ repositoryId }: { repositoryId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/repositories/${repositoryId}/scan`, { method: 'POST' });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        findings?: number;
        health?: number;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Scan failed');
      setNote(
        typeof body.findings === 'number'
          ? `Scan finished — ${body.findings} finding${body.findings === 1 ? '' : 's'}.`
          : 'Scan finished.',
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-auto sm:items-end">
      <Button onClick={run} disabled={pending} size="sm" className="w-full sm:w-auto">
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        {pending ? 'Scanning…' : 'Run scan'}
      </Button>
      {error ? (
        <p role="alert" className="max-w-xs text-left text-xs text-[hsl(var(--critical))] sm:text-right">
          {error}
        </p>
      ) : null}
      {note && !error ? (
        <p className="max-w-xs text-left text-xs text-[hsl(var(--muted-foreground))] sm:text-right">{note}</p>
      ) : null}
    </div>
  );
}
