'use client';

import * as React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[codesentinel] route error', error);
  }, [error]);

  return (
    <Card className="mx-auto max-w-lg">
      <div className="space-y-5 p-8">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[hsl(var(--critical))]/10">
          <AlertTriangle className="size-5 text-[hsl(var(--critical))]" aria-hidden="true" />
        </div>
        <div className="space-y-2 text-center">
          <h2 className="text-base font-semibold">This page could not be loaded</h2>
          <p className="text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            A request failed. Your repository data was not modified. You can retry, or return to Overview.
          </p>
        </div>
        <details className="rounded-lg border border-[hsl(var(--border))] px-4 py-3 text-left text-xs text-[hsl(var(--muted-foreground))]">
          <summary className="cursor-pointer font-medium text-[hsl(var(--foreground))]">Technical details</summary>
          <p className="mt-2 font-mono">{error.message || 'Unknown error'}</p>
          {error.digest ? <p className="mt-1 font-mono">digest: {error.digest}</p> : null}
        </details>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button onClick={reset} variant="outline" className="w-full sm:w-auto">
            <RotateCcw className="size-4" />
            Retry
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/">Overview</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
