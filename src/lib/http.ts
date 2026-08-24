import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirect helpers that survive reverse proxies.
 *
 * `new URL('/', request.url)` uses the address the server is *bound* to, which
 * is wrong whenever the app sits behind a proxy (Vercel, a container preview,
 * nginx). Binding to 0.0.0.0 would send the browser to `http://0.0.0.0:3000/`
 * and silently drop the session cookie, because it is a different origin.
 *
 * We therefore trust the standard forwarded headers, then APP_URL, and only
 * fall back to the request URL.
 */

function firstHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** Best-effort public origin of the current request, without a trailing slash. */
export function resolveOrigin(request: NextRequest): string {
  const host = firstHeaderValue(request.headers.get('x-forwarded-host')) ?? firstHeaderValue(request.headers.get('host'));

  if (host && !host.startsWith('0.0.0.0') && !host.startsWith('::')) {
    const proto =
      firstHeaderValue(request.headers.get('x-forwarded-proto')) ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    return `${proto}://${host}`;
  }

  // No usable Host header: fall back to the configured public URL.
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return appUrl.replace(/\/$/, '');

  return new URL(request.url).origin;
}

/**
 * Build an absolute URL for `path` (a same-origin, root-relative path) against
 * the request's public origin.
 */
export function absoluteUrl(request: NextRequest, path: string): URL {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(safePath, `${resolveOrigin(request)}/`);
}

/** Proxy-safe redirect. Defaults to 303 so POST → GET after form submission. */
export function redirectTo(request: NextRequest, path: string, status: 303 | 307 | 302 = 303): NextResponse {
  return NextResponse.redirect(absoluteUrl(request, path), { status });
}
