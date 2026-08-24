'use client';

import * as React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Route error boundary. Shows a recoverable message instead of a blank screen,
 * and never leaks internal stack details to the user in production.
 */
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

  const isDev = process.env.NODE_ENV === 'development';

  return (
    <Card className="mx-auto max-w-lg">
      <div className="space-y-5 p-8 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[hsl(var(--critical))]/10">
          <AlertTriangle className="size-5 text-[hsl(var(--critical))]" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h2 className="text-base font-semibold">Something went wrong</h2>
          <p className="text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            This page could not be rendered. The error has been logged.
          </p>
          {isDev ? (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-[hsl(var(--muted))] p-3 text-left font-mono text-[11px] leading-relaxed">
              {error.message}
            </pre>
          ) : null}
          {error.digest ? (
            <p className="font-mono text-[11px] text-[hsl(var(--muted-foreground))]">digest: {error.digest}</p>
          ) : null}
        </div>
        <Button onClick={reset} variant="outline">
          <RotateCcw className="size-4" />
          Try again
        </Button>
      </div>
    </Card>
  );
}
