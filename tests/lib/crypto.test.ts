import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  fingerprint,
  sha256,
  safeEqual,
  maskSecret,
  randomToken,
} from '@/lib/crypto';

describe('crypto', () => {
  it('round-trips a secret through AES-256-GCM', () => {
    const plaintext = 'ghp_exampletoken1234567890abcdefghijklmn';
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejects tampered ciphertext instead of returning garbage', () => {
    const encrypted = encryptSecret('sensitive');
    const parts = encrypted.split('.');
    const tampered = [parts[0], parts[1], parts[2], 'ZGVhZGJlZWY'].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('does not treat arbitrary strings as encrypted', () => {
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });

  it('fingerprints deterministically without revealing the input', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const fp = fingerprint(secret);

    expect(fp).toBe(fingerprint(secret));
    expect(fp).not.toContain(secret);
    expect(fp).not.toBe(fingerprint('AKIAIOSFODNN7EXAMPLF'));
  });

  it('masks secrets so they can never be displayed in full', () => {
    const masked = maskSecret('AKIAIOSFODNN7EXAMPLE');
    expect(masked).not.toContain('OSFODNN7EXAM');
    expect(masked).toContain('•');
    expect(maskSecret('abc')).not.toContain('abc');
  });

  it('compares strings without early exit', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'tokeN')).toBe(false);
    expect(safeEqual('token', 'different-length')).toBe(false);
  });

  it('generates unique random tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
  });

  it('hashes consistently with sha256', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).toHaveLength(64);
  });
});
