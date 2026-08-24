import { cn } from '@/lib/utils';

/**
 * Renders a unified diff.
 *
 * Colour alone never carries the meaning — every line keeps its `+`/`-`
 * marker, so the diff is still readable when copied as plain text, printed, or
 * viewed by someone who cannot distinguish the two hues.
 */
export function DiffView({ patch, className }: { patch: string; className?: string }) {
  const lines = patch.split('\n');

  return (
    <div
      className={cn(
        'overflow-x-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-sunken))] font-mono text-xs leading-relaxed',
        className,
      )}
    >
      <pre className="min-w-full">
        <code className="block">
          {lines.map((line, i) => {
            const kind = classify(line);
            return (
              <span
                key={i}
                className={cn(
                  'block whitespace-pre px-4 py-0.5',
                  kind === 'add' && 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]',
                  kind === 'remove' && 'bg-[hsl(var(--critical))]/10 text-[hsl(var(--critical))]',
                  kind === 'meta' && 'text-[hsl(var(--muted-foreground))]',
                  kind === 'hunk' && 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
                  kind === 'context' && 'text-[hsl(var(--foreground))]/70',
                )}
              >
                {line || ' '}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

type LineKind = 'add' | 'remove' | 'meta' | 'hunk' | 'context';

function classify(line: string): LineKind {
  // Order matters: the `---`/`+++` file headers start with the same characters
  // as removed/added lines and must be checked first.
  if (line.startsWith('---') || line.startsWith('+++')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/** Line-numbered code block for showing a file excerpt. */
export function CodeBlock({
  code,
  startLine = 1,
  highlightLine,
  className,
}: {
  code: string;
  startLine?: number;
  highlightLine?: number | null;
  className?: string;
}) {
  const lines = code.split('\n');

  return (
    <div
      className={cn(
        'overflow-x-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-sunken))] font-mono text-xs leading-relaxed',
        className,
      )}
    >
      <pre className="min-w-full">
        <code className="block py-2">
          {lines.map((line, i) => {
            const lineNumber = startLine + i;
            const isHighlighted = highlightLine === lineNumber;
            return (
              <span
                key={i}
                className={cn(
                  'flex whitespace-pre',
                  isHighlighted && 'bg-[hsl(var(--critical))]/10',
                )}
              >
                <span
                  className={cn(
                    'sticky left-0 w-12 shrink-0 select-none border-r border-[hsl(var(--border))] bg-[hsl(var(--surface-sunken))] px-2 text-right text-[hsl(var(--muted-foreground))]',
                    isHighlighted && 'text-[hsl(var(--critical))]',
                  )}
                >
                  {lineNumber}
                </span>
                <span className="px-3">{line || ' '}</span>
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
