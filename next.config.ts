import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 * CodeSentinel handles GitHub tokens, so we lock the browser surface down.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Preview/embed hosts (Arena, Render) load the app in a cross-origin iframe.
  // SAMEORIGIN here produces a blank frame that looks like a 502. Clickjacking
  // is an acceptable trade-off for a self-hosted dashboard.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/api/**': ['./fixtures/**/*'],
  },
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  eslint: {
    ignoreDuringBuilds: false,
    dirs: ['src'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
