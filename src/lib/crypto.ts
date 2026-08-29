import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { getEnv } from './env';













const VERSION = 'v1';
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = getEnv();
  const raw = env.ENCRYPTION_KEY.trim();

  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32).');
    }
    cachedKey = buf;
  } else {


    cachedKey = scryptSync(env.SESSION_SECRET, 'codesentinel:token-encryption:v1', 32);
  }
  return cachedKey;
}


export function resetCryptoCache(): void {
  cachedKey = null;
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret requires a non-empty string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted payload');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}


export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}









export function fingerprint(value: string, salt = 'codesentinel'): string {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 32);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}


export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}





export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '•'.repeat(8);
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  return `${head}${'•'.repeat(Math.min(12, Math.max(4, trimmed.length - 8)))}${tail}`;
}
