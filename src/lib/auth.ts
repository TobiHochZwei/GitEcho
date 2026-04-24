// UI authentication: bcrypt-hashed password stored in the encrypted vault,
// plus an in-memory session store keyed by opaque random ids. Sessions use a
// sliding 7-day expiry, so active users are never prompted to sign in again
// while idle sessions eventually expire.

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

import { loadSettings, readSecret, saveSettings, writeSecret } from './settings.js';
import { logger } from './logger.js';

const SESSION_COOKIE_NAME = 'gitecho_sid';
/** 7 days, in milliseconds. Sliding: each request extends this. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';
const MIN_PASSWORD_LENGTH = 8;

export interface SessionData {
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, SessionData>();

function hmacKey(): Buffer {
  const raw = process.env.MASTER_KEY ?? '';
  // Reuse MASTER_KEY material for cookie HMAC — the same vault key that
  // protects the password hash. No separate secret to manage.
  return Buffer.from(raw, 'utf-8');
}

function signSid(sid: string): string {
  return createHmac('sha256', hmacKey()).update(sid).digest('base64url');
}

function buildCookieValue(sid: string): string {
  return `${sid}.${signSid(sid)}`;
}

function parseCookieValue(raw: string): string | undefined {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const sid = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = signSid(sid);
  if (mac.length !== expected.length) return undefined;
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined;
  } catch {
    return undefined;
  }
  return sid;
}

/** Parse a Cookie header and return the gitecho_sid value if present. */
function readSidFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return parseCookieValue(value);
  }
  return undefined;
}

function nowMs(): number {
  return Date.now();
}

function gcSessions(): void {
  const cutoff = nowMs() - SESSION_TTL_MS;
  for (const [sid, data] of sessions) {
    if (data.lastSeenAt < cutoff) sessions.delete(sid);
  }
}

/** True if the credentials vault has been seeded. */
export function hasStoredCredentials(): boolean {
  return Boolean(readSecret('ui.passwordHash'));
}

/**
 * Ensure a password hash exists on disk. On a fresh install this seeds the
 * default admin/admin credentials and marks `mustChangePassword=true`, which
 * the middleware uses to force the user through the change-password flow.
 */
export function ensureCredentialsBootstrapped(): void {
  if (hasStoredCredentials()) return;

  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, BCRYPT_COST);
  writeSecret('ui.passwordHash', hash);

  const settings = loadSettings();
  saveSettings({
    ...settings,
    ui: {
      ...(settings.ui ?? {}),
      username: DEFAULT_USERNAME,
      mustChangePassword: true,
      passwordUpdatedAt: new Date().toISOString(),
    },
  });

  logger.warn(
    '[auth] No UI credentials found — bootstrapped with default admin/admin. ' +
      'Sign in and change the password immediately at /settings/account.',
  );
}

/** Read the configured username (falls back to "admin" if unset). */
export function getUsername(): string {
  const settings = loadSettings();
  return settings.ui?.username ?? DEFAULT_USERNAME;
}

export function mustChangePassword(): boolean {
  const settings = loadSettings();
  return Boolean(settings.ui?.mustChangePassword);
}

/**
 * Verify a username + plaintext password against the stored bcrypt hash.
 * Uses bcrypt's own constant-time compare.
 */
export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const settings = loadSettings();
  const expectedUser = settings.ui?.username ?? DEFAULT_USERNAME;
  const hash = readSecret('ui.passwordHash');
  if (!hash) return false;
  // Still run bcrypt.compare when the username is wrong so the response time
  // doesn't leak whether the username matched.
  const pwOk = await bcrypt.compare(password, hash);
  const userOk = username === expectedUser;
  return pwOk && userOk;
}

/**
 * Atomically replace the stored password (and optionally the username).
 * Clears the must-change-password flag and invalidates every existing session.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  newUsername?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = loadSettings();
  const username = settings.ui?.username ?? DEFAULT_USERNAME;
  const okNow = await verifyCredentials(username, currentPassword);
  if (!okNow) return { ok: false, error: 'Current password is incorrect.' };

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (newPassword === DEFAULT_PASSWORD) {
    return { ok: false, error: 'Password must differ from the default.' };
  }
  const targetUser = (newUsername ?? username).trim();
  if (!targetUser) {
    return { ok: false, error: 'Username cannot be empty.' };
  }
  if (newPassword === targetUser) {
    return { ok: false, error: 'Password must differ from the username.' };
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);

  writeSecret('ui.passwordHash', hash);

  saveSettings({
    ...settings,
    ui: {
      ...(settings.ui ?? {}),
      username: targetUser,
      mustChangePassword: false,
      passwordUpdatedAt: new Date().toISOString(),
    },
  });

  sessions.clear();
  logger.info('[auth] UI password changed; all sessions invalidated.');
  return { ok: true };
}

export function createSession(username: string): string {
  gcSessions();
  const sid = randomBytes(32).toString('base64url');
  const ts = nowMs();
  sessions.set(sid, { username, createdAt: ts, lastSeenAt: ts });
  return sid;
}

/**
 * Look up a session by signed cookie value, extending `lastSeenAt` on hit
 * (sliding expiry). Returns undefined for unknown or expired sessions.
 */
export function touchSession(cookieHeader: string | null): SessionData | undefined {
  const sid = readSidFromHeader(cookieHeader);
  if (!sid) return undefined;
  const data = sessions.get(sid);
  if (!data) return undefined;
  if (data.lastSeenAt < nowMs() - SESSION_TTL_MS) {
    sessions.delete(sid);
    return undefined;
  }
  data.lastSeenAt = nowMs();
  return data;
}

export function destroySessionByCookie(cookieHeader: string | null): void {
  const sid = readSidFromHeader(cookieHeader);
  if (sid) sessions.delete(sid);
}

export function destroyAllSessions(): void {
  sessions.clear();
}

export function sessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function sessionCookieMaxAgeSeconds(): number {
  return Math.floor(SESSION_TTL_MS / 1000);
}

/**
 * Build a `Set-Cookie` value for the signed session id. Production deployments
 * terminate TLS at a reverse proxy, so we trust `X-Forwarded-Proto` (when
 * honoured by the proxy) plus the request URL scheme to decide whether to
 * emit the `Secure` attribute.
 */
export function buildSessionCookie(sid: string, secure: boolean): string {
  const value = encodeURIComponent(buildCookieValue(sid));
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${sessionCookieMaxAgeSeconds()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** True if the incoming request looks like it's over HTTPS. */
export function requestIsSecure(request: Request): boolean {
  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') return true;
  } catch {
    /* ignore */
  }
  const xfp = request.headers.get('x-forwarded-proto');
  if (xfp && xfp.split(',')[0].trim().toLowerCase() === 'https') return true;
  return false;
}
