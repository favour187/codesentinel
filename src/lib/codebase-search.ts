




export interface SearchDocument {
  readonly kind: 'file' | 'symbol' | 'package' | 'route';
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly path: string | null;
  readonly haystack: string;
}

export interface SearchHit extends SearchDocument {
  readonly score: number;
}








export function searchDocuments(documents: readonly SearchDocument[], query: string, limit = 30): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  for (const doc of documents) {
    const title = doc.title.toLowerCase();
    const hay = doc.haystack.toLowerCase();
    let score = 0;
    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    else if (hay.includes(q)) score = 30;
    if (score === 0) continue;
    hits.push({ ...doc, score });
  }

  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
