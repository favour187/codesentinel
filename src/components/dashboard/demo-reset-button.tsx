'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DemoResetButton() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function reset() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/repositories/demo/reset', { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Reset failed');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={reset} disabled={pending} size="sm" variant="outline">
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}
        {pending ? 'Resetting…' : 'Reset demo'}
      </Button>
      {error ? (
        <p role="alert" className="max-w-xs text-right text-xs text-[hsl(var(--critical))]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
