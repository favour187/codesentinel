


const { describe, it, expect } = require('vitest');
const { createSession, getSession } = require('../src/auth/session');

describe('session', () => {
  it('creates a session that can be read back', () => {
    const id = createSession(42, 'viewer');
    expect(getSession(id).userId).toBe(42);
  });

  it('returns undefined for an unknown session id', () => {
    expect(getSession('nope')).toBe(undefined);
  });
});
