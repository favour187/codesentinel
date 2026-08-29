import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { resolveOrigin, absoluteUrl } from '@/lib/http';


function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  return { url, headers: new Headers(headers) } as unknown as NextRequest;
}

describe('resolveOrigin', () => {
  it('prefers the forwarded host and protocol behind a proxy', () => {
    const req = makeRequest('http://0.0.0.0:3000/api/auth/demo', {
      'x-forwarded-host': '3000-abc123.e2b.app',
      'x-forwarded-proto': 'https',
    });
    expect(resolveOrigin(req)).toBe('https://3000-abc123.e2b.app');
  });

  it('uses the Host header when no forwarded header is present', () => {
    const req = makeRequest('http://0.0.0.0:3000/x', { host: 'localhost:3000' });
    expect(resolveOrigin(req)).toBe('http://localhost:3000');
  });






  it('never returns a 0.0.0.0 origin', () => {
    const req = makeRequest('http://0.0.0.0:3000/api/auth/demo', { host: '0.0.0.0:3000' });
    expect(resolveOrigin(req)).not.toContain('0.0.0.0');
    expect(resolveOrigin(req)).toBe('http://localhost:3000');
  });

  it('takes only the first value of a comma-joined forwarded header', () => {
    const req = makeRequest('http://0.0.0.0:3000/x', {
      'x-forwarded-host': 'public.example.com, internal.local',
      'x-forwarded-proto': 'https, http',
    });
    expect(resolveOrigin(req)).toBe('https://public.example.com');
  });

  it('assumes https for non-local hosts when the protocol is not forwarded', () => {
    const req = makeRequest('http://0.0.0.0:3000/x', { host: 'codesentinel.example.com' });
    expect(resolveOrigin(req)).toBe('https://codesentinel.example.com');
  });
});

describe('absoluteUrl', () => {
  it('builds an absolute URL against the public origin', () => {
    const req = makeRequest('http://0.0.0.0:3000/api/auth/demo', {
      'x-forwarded-host': 'preview.example.app',
      'x-forwarded-proto': 'https',
    });
    expect(absoluteUrl(req, '/').toString()).toBe('https://preview.example.app/');
    expect(absoluteUrl(req, '/login?error=demo_failed').toString()).toBe(
      'https://preview.example.app/login?error=demo_failed',
    );
  });

  it('normalises a path that is missing its leading slash', () => {
    const req = makeRequest('http://0.0.0.0:3000/x', { host: 'localhost:3000' });
    expect(absoluteUrl(req, 'settings').pathname).toBe('/settings');
  });
});
