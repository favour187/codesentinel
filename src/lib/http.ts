import { NextResponse, type NextRequest } from 'next/server';













function firstHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}


export function resolveOrigin(request: NextRequest): string {
  const host = firstHeaderValue(request.headers.get('x-forwarded-host')) ?? firstHeaderValue(request.headers.get('host'));

  if (host && !host.startsWith('0.0.0.0') && !host.startsWith('::')) {
    const proto =
      firstHeaderValue(request.headers.get('x-forwarded-proto')) ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    return `${proto}://${host}`;
  }


  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return appUrl.replace(/\/$/, '');

  return new URL(request.url).origin;
}





export function absoluteUrl(request: NextRequest, path: string): URL {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(safePath, `${resolveOrigin(request)}/`);
}


export function redirectTo(request: NextRequest, path: string, status: 303 | 307 | 302 = 303): NextResponse {
  return NextResponse.redirect(absoluteUrl(request, path), { status });
}
