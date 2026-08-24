import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="text-center">
        <p className="font-mono text-sm text-[hsl(var(--muted-foreground))]">404</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
          This route does not exist. CodeSentinel keeps a deliberately small navigation surface.
        </p>
        <Button asChild className="mt-6">
          <Link href="/">Back to Overview</Link>
        </Button>
      </div>
    </div>
  );
}
