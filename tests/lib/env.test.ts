import { describe, it, expect, afterEach } from 'vitest';
import { getEnv, getFeatures, resetEnvCache } from '@/lib/env';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  resetEnvCache();
});

describe('env validation', () => {
  it('parses a valid environment', () => {
    const env = getEnv();
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('rejects a session secret that is too short', () => {
    resetEnvCache();
    process.env.SESSION_SECRET = 'short';
    expect(() => getEnv()).toThrow();
  });

  it('detects optional features as disabled when unset', () => {
    const features = getFeatures();
    expect(features.githubOAuth).toBe(false);
    expect(features.githubApp).toBe(false);
    expect(features.llm).toBe(false);
    expect(features.postgres).toBe(false);
  });

  it('enables GitHub OAuth only when both credentials are present', () => {
    resetEnvCache();
    process.env.GITHUB_CLIENT_ID = 'Iv1.abc123';
    expect(getFeatures().githubOAuth).toBe(false);

    resetEnvCache();
    process.env.GITHUB_CLIENT_SECRET = 'secret-value';
    expect(getFeatures().githubOAuth).toBe(true);
  });

  it('strips wrapping quotes and Bearer prefix from API keys', () => {
    resetEnvCache();
    process.env.GROQ_API_KEY = '"Bearer gsk-quoted-key"';
    expect(getEnv().GROQ_API_KEY).toBe('gsk-quoted-key');
    expect(getFeatures().groq).toBe(true);
  });

  it('enables the LLM feature when either AI provider has a key', () => {
    resetEnvCache();
    process.env.FEATHERLESS_API_KEY = 'fk-test-key';
    expect(getFeatures().llm).toBe(true);
    expect(getFeatures().featherless).toBe(true);
    expect(getFeatures().groq).toBe(false);

    resetEnvCache();
    delete process.env.FEATHERLESS_API_KEY;
    process.env.GROQ_API_KEY = 'gsk-test-key';
    expect(getFeatures().llm).toBe(true);
    expect(getFeatures().featherless).toBe(false);
    expect(getFeatures().groq).toBe(true);

    resetEnvCache();
    delete process.env.GROQ_API_KEY;
    expect(getFeatures().llm).toBe(false);
  });
});
