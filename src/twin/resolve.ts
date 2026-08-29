














const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] as const;
const JS_INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'] as const;


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









function resolveJs(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  let base: string;

  if (specifier.startsWith('.')) {
    base = join(dirOf(fromPath), specifier);
  } else if (specifier.startsWith('@/')) {

    const stripped = specifier.slice(2);
    for (const prefix of ['src/', '']) {
      const hit = tryCandidates(`${prefix}${stripped}`, known);
      if (hit) return hit;
    }
    return null;
  } else if (specifier.startsWith('~/')) {
    return tryCandidates(specifier.slice(2), known);
  } else {

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










function resolvePython(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const bare = specifier.slice(leadingDots);
  const segments = bare.split('.').filter((s) => s.length > 0);

  const bases: string[] = [];

  if (leadingDots > 0) {

    let dir = dirOf(fromPath);
    for (let i = 1; i < leadingDots; i += 1) dir = dirOf(dir);
    bases.push(join(dir, segments.join('/')));
  } else {
    bases.push(segments.join('/'));

    for (const root of ['src', 'app', 'lib']) {
      bases.push(`${root}/${segments.join('/')}`);
    }
  }

  for (const base of bases) {
    if (!base) continue;
    if (known.has(`${base}.py`)) return `${base}.py`;
    if (known.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    if (known.has(base)) return base;




    const parent = base.split('/').slice(0, -1).join('/');
    if (parent && known.has(`${parent}.py`)) return `${parent}.py`;
  }

  return null;
}








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


  return resolved === fromPath ? null : resolved;
}









export function isExternalSpecifier(specifier: string, language: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/')) return false;
  if (language === 'python') {

    return !specifier.startsWith('.');
  }
  return true;
}







export function packageNameOf(specifier: string, language: string): string {
  if (language === 'python') return specifier.split('.')[0] ?? specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}
