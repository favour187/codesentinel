import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'fixtures/**', '.next/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /*
     * One test file at a time, each in its own forked process.
     *
     * Most suites boot a PGlite instance per test — an in-process WASM
     * Postgres. Closing it releases the handle but the WASM heap is not
     * returned to the OS, so memory only really comes back when the process
     * exits. Two things follow, and both are load-bearing:
     *
     *   maxWorkers: 1 — running several DB-heavy files concurrently pushed RSS
     *                  past the container limit and the kernel OOM-killed the
     *                  workers. Vitest surfaces that as "Worker exited
     *                  unexpectedly", which reads like flakiness but is not.
     *   isolate: true — each file gets a fresh process, so the accumulated
     *                  WASM heap is reclaimed between files.
     *
     * The harness also reuses a single PGlite instance per process and
     * truncates between tests; see tests/helpers/test-db.ts.
     *
     * Parallelism bought little here anyway: the work is allocation-bound and
     * the box has 2 cores. This trades wall clock for a deterministic result.
     */
    pool: 'forks',
    isolate: true,
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/app/**/layout.tsx', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src/', import.meta.url).pathname,
    },
  },
});
