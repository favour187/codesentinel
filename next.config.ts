import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 * CodeSentinel handles GitHub tokens, so we lock the browser surface down.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
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
