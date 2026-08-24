/**
 * Global test setup.
 *
 * Establishes a deterministic environment BEFORE any module reads process.env,
 * so env validation and crypto key derivation behave identically on every
 * machine and in CI.
 */
// NODE_ENV is typed readonly; assign through an index signature.
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = 'test-session-secret-value-at-least-32-chars-long';
// 32 bytes, base64 — deterministic so encrypted fixtures stay decryptable.
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL = '';
// No AI provider keys in tests: every AI path must be explicitly stubbed, and
// the deterministic suite must pass with AI entirely unavailable.
delete process.env.FEATHERLESS_API_KEY;
delete process.env.GROQ_API_KEY;

import { afterEach } from 'vitest';
import { closeTestDbs } from './helpers/test-db';

// Release PGlite WASM instances between tests so workers do not run out of memory.
afterEach(async () => {
  await closeTestDbs();
});
