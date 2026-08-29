







(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = 'test-session-secret-value-at-least-32-chars-long';

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL = '';


delete process.env.FEATHERLESS_API_KEY;
delete process.env.GROQ_API_KEY;

import { afterEach } from 'vitest';
import { closeTestDbs } from './helpers/test-db';


afterEach(async () => {
  await closeTestDbs();
});
