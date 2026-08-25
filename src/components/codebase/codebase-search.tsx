'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { searchDocuments, type SearchDocument } from '@/lib/codebase-search';

export function CodebaseSearch({ documents }: { documents: SearchDocument[] }) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchDocuments(documents, query), [documents, query]);

  return (
    <div>
      <label className="sr-only" htmlFor="codebase-search">
        Search files, symbols, packages and routes
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
        <Search className="size-4 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
        <input
          id="codebase-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files, symbols, packages, routes…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {query.trim() ? (
        <ul className="mt-4 divide-y divide-[hsl(var(--border))]" role="listbox" aria-label="Search results">
          {hits.length === 0 ? (
            <li className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
              No matches for “{query.trim()}”. Search only covers indexed files, symbols, packages and
              detected routes.
            </li>
          ) : (
            hits.map((hit) => (
              <li key={hit.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm">{hit.title}</p>
                  <p className="mt-0.5 break-all text-xs text-[hsl(var(--muted-foreground))]">{hit.subtitle}</p>
                </div>
                <span className="shrink-0 text-xs capitalize text-[hsl(var(--muted-foreground))]">{hit.kind}</span>
              </li>
            ))
          )}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
          {documents.length} indexed items. Type to search — the whole repository is never sent to a model.
        </p>
      )}
    </div>
  );
}
