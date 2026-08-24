import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { redirectTo } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  return POST(request);
}

export function POST(request: NextRequest): NextResponse {
  const response = redirectTo(request, '/login');
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return response;
}
