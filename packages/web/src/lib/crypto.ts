/**
 * Token encryption at rest.
 *
 * OAuth refresh tokens are bearer credentials for the founder's own Reddit and
 * GitHub accounts. A database leak must not become an account takeover, so
 * everything is sealed with AES-256-GCM using a key from the environment.
 *
 * The ciphertext format is `v1.<iv>.<tag>.<data>`, all base64url, so we can
 * rotate the scheme later without guessing what is in the column.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? '';
  if (!raw) {
    // In development a fixed dev key keeps tokens readable across restarts.
    return createHashKey('upvote-development-key-do-not-use-in-production');
  }
  // Accept hex, base64 or a raw 32-character passphrase.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw.length === 32) return Buffer.from(raw, 'utf8');
  return createHashKey(raw);
}

function createHashKey(secret: string): Buffer {
  // Deterministic 32 bytes from an arbitrary string.
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

export function decrypt(sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised token format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64!, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Encrypt a token bundle as one JSON string. */
export function encryptTokens(tokens: Record<string, unknown>): string {
  return encrypt(JSON.stringify(tokens));
}

export function decryptTokens<T extends Record<string, unknown>>(sealed: string): T {
  return JSON.parse(decrypt(sealed)) as T;
}

/** Never log or return these. */
export function redactToken(value: string | null | undefined): string {
  if (!value) return '(none)';
  return `${value.slice(0, 3)}...${value.slice(-2)} (${value.length} chars)`;
}