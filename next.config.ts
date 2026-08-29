import type { NextConfig } from 'next';





const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },



  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  output: 'standalone',
  outputFileTracingIncludes: {
    '/api/**': ['./fixtures/**/*'],
    '/': ['./fixtures/**/*'],
  },
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  eslint: {

    ignoreDuringBuilds: process.env.RENDER === 'true',
    dirs: ['src'],
  },
  typescript: {

    ignoreBuildErrors: process.env.RENDER === 'true',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
