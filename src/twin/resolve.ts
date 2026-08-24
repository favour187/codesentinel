/**
 * Module specifier resolution.
 *
 * Turns an import as written (`./auth`, `../lib/db`, `app.models`) into a real
 * repository path, or into nothing. Returning nothing is a valid and common
 * answer: `express` is a package, not a file, and inventing an edge to satisfy
 * an unresolved specifier is exactly the failure this module exists to avoid.
 *
 * The guardian pipeline has a regex-based `resolveImports` that re-reads file
 * content. This module deliberately takes already-parsed specifiers instead —
 * the parsers have done that work with a real AST — and adds Python support,
 * which the guardian's TS-only candidate list cannot express.
 */

/** Extension candidates tried for a bare TS/JS specifier, in resolution order. */
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] as const;
const JS_INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'] as const;

/** Collapse `.` and `..` segments. Never escapes above the repository root. */
export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function dirOf(filePath: string): string {
  return filePath.split('/').slice(0, -1).join('/');
}

function join(dir: string, rel: string): string {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

/**
 * Resolve a TypeScript/JavaScript specifier.
 *
 * Handles relative paths, `@/`-style root aliases (the convention this project
 * and most Next.js repositories use), and extensionless imports. Bare package
 * specifiers resolve to null by design — they are dependency edges, not file
 * edges, and the indexer records them as such.
 */
function resolveJs(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  let base: string;

  if (specifier.startsWith('.')) {
    base = join(dirOf(fromPath), specifier);
  } else if (specifier.startsWith('@/')) {
    // Common tsconfig alias for the source root. Try both `src/` and root.
    const stripped = specifier.slice(2);
    for (const prefix of ['src/', '']) {
      const hit = tryCandidates(`${prefix}${stripped}`, known);
      if (hit) return hit;
    }
    return null;
  } else if (specifier.startsWith('~/')) {
    return tryCandidates(specifier.slice(2), known);
  } else {
    // Bare specifier: a package, handled as a DEPENDS_ON edge elsewhere.
    return null;
  }

  return tryCandidates(base, known);
}

function tryCandidates(base: string, known: ReadonlySet<string>): string | null {
  if (known.has(base)) return base;
  for (const ext of JS_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (known.has(candidate)) return candidate;
  }
  for (const index of JS_INDEX_FILES) {
    const candidate = `${base}/${index}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a Python specifier.
 *
 * Python import syntax is dotted rather than path-like, and leading dots mean
 * "go up a package". `from .models import User` in `app/repo.py` is
 * `app/models.py`; `from ..db import pool` is `db.py` one level up. Absolute
 * dotted names are tried against the repository root and against common source
 * roots, since `from app.models import X` works when `app/` sits at the root.
 */
function resolvePython(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const bare = specifier.slice(leadingDots);
  const segments = bare.split('.').filter((s) => s.length > 0);

  const bases: string[] = [];

  if (leadingDots > 0) {
    // One dot = current package; each extra dot climbs one level.
    let dir = dirOf(fromPath);
    for (let i = 1; i < leadingDots; i += 1) dir = dirOf(dir);
    bases.push(join(dir, segments.join('/')));
  } else {
    bases.push(segments.join('/'));
    // `from app.models import X` where the package lives under a source root.
    for (const root of ['src', 'app', 'lib']) {
      bases.push(`${root}/${segments.join('/')}`);
    }
  }

  for (const base of bases) {
    if (!base) continue;
    if (known.has(`${base}.py`)) return `${base}.py`;
    if (known.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    if (known.has(base)) return base;
    /*
     * `from app.models import User` may name a symbol inside `app/models.py`
     * rather than a module — drop the last segment and retry.
     */
    const parent = base.split('/').slice(0, -1).join('/');
    if (parent && known.has(`${parent}.py`)) return `${parent}.py`;
  }

  return null;
}

/**
 * Resolve one specifier to a repository-relative path, or null.
 *
 * Null means "this does not point at a file in this repository" — a package, a
 * standard-library module, or a path that genuinely is not there. Callers must
 * treat null as "no edge", never as "guess something".
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
  language: string,
): string | null {
  if (!specifier) return null;
  const resolved = language === 'python'
    ? resolvePython(fromPath, specifier, knownPaths)
    : resolveJs(fromPath, specifier, knownPaths);

  // A file importing itself is a resolution artefact, not a real edge.
  return resolved === fromPath ? null : resolved;
}

/**
 * Is this specifier an external package rather than a repository file?
 *
 * Used to split IMPORTS edges (file → file) from DEPENDS_ON edges
 * (file → package). Relative and aliased specifiers are always internal even
 * when they fail to resolve — a broken relative import is a missing file, not
 * a dependency.
 */
export function isExternalSpecifier(specifier: string, language: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/')) return false;
  if (language === 'python') {
    // Relative python imports start with a dot; everything else may be external.
    return !specifier.startsWith('.');
  }
  return true;
}

/**
 * The installable package name for a bare specifier.
 *
 * `@scope/pkg/sub` → `@scope/pkg`; `express/lib/router` → `express`;
 * `psycopg2.extras` → `psycopg2`. This is what matches a manifest entry.
 */
export function packageNameOf(specifier: string, language: string): string {
  if (language === 'python') return specifier.split('.')[0] ?? specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}
