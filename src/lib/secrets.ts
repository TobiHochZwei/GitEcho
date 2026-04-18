// AES-256-GCM secret encryption using a MASTER_KEY environment variable.
// Per-secret JSON envelope keeps each value self-contained and rotatable.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  iv: string;
  tag: string;
  ct: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | undefined;

function decodeMasterKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Try base64 — Node accepts loose input, so verify length after decode
  const buf = Buffer.from(raw, 'base64');
  return buf;
}

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_KEY environment variable is required to read or write secrets. ' +
        'Generate one with `openssl rand -hex 32`.',
    );
  }
  const buf = decodeMasterKey(raw);
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}). ` +
        'Generate one with `openssl rand -hex 32`.',
    );
  }
  cachedKey = buf;
  return buf;
}

export function isMasterKeyConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const key = getMasterKey();
  const iv = Buffer.from(secret.iv, 'base64');
  const tag = Buffer.from(secret.tag, 'base64');
  const ct = Buffer.from(secret.ct, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ct === 'string';
}

/** Reset cached key — used in tests after MASTER_KEY changes. */
export function _resetForTests(): void {
  cachedKey = undefined;
}
