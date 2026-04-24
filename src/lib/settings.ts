// JSON-backed settings store layered on top of environment defaults.
// Two files live in /config:
//   - settings.json : non-secret config (cron, backup mode, smtp host, etc.)
//   - secrets.json  : encrypted secret blobs (PATs, SMTP password)
//
// Both files are re-read whenever their mtime changes so the worker picks up
// UI changes between cycles without a restart.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { decryptSecret, encryptSecret, isEncryptedSecret } from './secrets.js';
import type { EncryptedSecret } from './secrets.js';
import { logger, setLevel } from './logger.js';

export interface DiscoveryFilterSettings {
  /** Case-insensitive list of owners/orgs to allow. Empty/undefined = no allow filter. */
  ownerAllowList?: string[];
  /** Case-insensitive list of owners/orgs to drop. Empty/undefined = no deny filter. */
  ownerDenyList?: string[];
  /** Filter by visibility. Defaults to 'all'. */
  visibility?: 'all' | 'public' | 'private';
}

export interface ProviderSettings {
  patExpires?: string; // ISO date
  /**
   * Discover all repositories visible to the configured PAT. Honoured for
   * GitHub, Azure DevOps, and GitLab. Defaults to true.
   */
  autoDiscover?: boolean;
  org?: string; // Azure DevOps only
  host?: string; // GitLab only (default gitlab.com, set for self-hosted)
  /**
   * After each successful discovery cycle, remove URLs from /config/repos.txt
   * that are already covered by the database (i.e. redundant pins).
   * Defaults to true — keeps repos.txt focused on actual extras.
   */
  autoCleanupReposTxt?: boolean;
  /** Send an SMTP notification when previously-unseen repos are discovered. Defaults to true. */
  notifyOnNewRepo?: boolean;
  /** Filters applied to the discovery result before persistence. */
  filters?: DiscoveryFilterSettings;
  /**
   * Repository URLs that must never be auto-discovered again. Populated from
   * the "Remove & exclude" action on the Repositories page. Matched case-
   * insensitively against RepositoryInfo.url.
   */
  excludedUrls?: string[];
}

export interface SmtpSettings {
  host?: string;
  port?: number;
  user?: string;
  from?: string;
  to?: string;
}

export interface UiSettings {
  /** Human-readable UI username. Defaults to "admin" on a fresh install. */
  username?: string;
  /**
   * When true, the middleware redirects every authenticated request to the
   * account page until the user picks a new password. Set automatically on
   * bootstrap (admin/admin) and cleared on successful change.
   */
  mustChangePassword?: boolean;
  /** ISO timestamp of the last successful password change. */
  passwordUpdatedAt?: string;
}

export interface PersistedSettings {
  github?: ProviderSettings;
  azureDevOps?: ProviderSettings;
  gitlab?: ProviderSettings;
  backupMode?: 'option1' | 'option2' | 'option3';
  cronSchedule?: string;
  /**
   * IANA timezone the cron schedule is interpreted in (e.g. `Europe/Berlin`).
   * Defaults to the worker's `TZ` env, else UTC. Requires a worker restart
   * to take effect, same as `cronSchedule`.
   */
  cronTimezone?: string;
  /**
   * When false, the scheduled cron tick is skipped and only manually
   * triggered backups run. Defaults to true. Changes take effect on the
   * next tick without requiring a worker restart.
   */
  cronEnabled?: boolean;
  /**
   * When true, the worker runs a full backup cycle immediately on boot, in
   * addition to the cron schedule. Defaults to false so only the cron runs.
   */
  runBackupOnStart?: boolean;
  smtp?: SmtpSettings;
  notifyOnSuccess?: boolean;
  patExpiryWarnDays?: number;
  /** Logging verbosity surfaced in /logs UI. Overrides LOG_LEVEL env. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Web-UI authentication settings (username + password metadata). */
  ui?: UiSettings;
}

export interface PersistedSecrets {
  'github.pat'?: EncryptedSecret;
  'azureDevOps.pat'?: EncryptedSecret;
  'gitlab.pat'?: EncryptedSecret;
  'smtp.pass'?: EncryptedSecret;
  /** bcrypt hash of the Web UI password (wrapped in the AES vault). */
  'ui.passwordHash'?: EncryptedSecret;
}

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';

interface CacheEntry<T> {
  mtimeMs: number;
  value: T;
}

const settingsCache = new Map<string, CacheEntry<PersistedSettings>>();
const secretsCache = new Map<string, CacheEntry<PersistedSecrets>>();

function configDir(): string {
  return process.env.CONFIG_DIR ?? '/config';
}

function settingsPath(): string {
  return join(configDir(), SETTINGS_FILE);
}

function secretsPath(): string {
  return join(configDir(), SECRETS_FILE);
}

function readJsonIfFresh<T>(path: string, cache: Map<string, CacheEntry<T>>): T | undefined {
  if (!existsSync(path)) {
    cache.delete(path);
    return undefined;
  }
  const stat = statSync(path);
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.value;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const value = JSON.parse(raw) as T;
    cache.set(path, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (err) {
    logger.error(`[settings] Failed to parse ${path}:`, err);
    return undefined;
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

export function loadSettings(): PersistedSettings {
  const settings = readJsonIfFresh<PersistedSettings>(settingsPath(), settingsCache) ?? {};
  // Sync the logger level with the UI-managed override. Undefined clears it
  // so the logger falls back to the LOG_LEVEL env var.
  setLevel(settings.logLevel);
  return settings;
}

export function saveSettings(next: PersistedSettings): void {
  atomicWriteJson(settingsPath(), next);
  settingsCache.delete(settingsPath());
}

/** Add a repository URL to a provider's discovery blacklist. Idempotent. */
export function addExcludedUrl(provider: 'github' | 'azureDevOps' | 'gitlab', url: string): void {
  const s = loadSettings();
  const p = s[provider] ?? {};
  const normalized = url.trim();
  const set = new Set((p.excludedUrls ?? []).map((u) => u.toLowerCase()));
  if (set.has(normalized.toLowerCase())) return;
  const list = [...(p.excludedUrls ?? []), normalized];
  saveSettings({ ...s, [provider]: { ...p, excludedUrls: list } });
}

/** Remove a URL from a provider's blacklist. Returns true when something was removed. */
export function removeExcludedUrl(provider: 'github' | 'azureDevOps' | 'gitlab', url: string): boolean {
  const s = loadSettings();
  const p = s[provider];
  if (!p?.excludedUrls || p.excludedUrls.length === 0) return false;
  const lower = url.trim().toLowerCase();
  const next = p.excludedUrls.filter((u) => u.toLowerCase() !== lower);
  if (next.length === p.excludedUrls.length) return false;
  saveSettings({ ...s, [provider]: { ...p, excludedUrls: next } });
  return true;
}

/** Return true when a URL is blacklisted under any provider. */
export function isUrlExcluded(url: string): boolean {
  const s = loadSettings();
  const lower = url.trim().toLowerCase();
  return (
    (s.github?.excludedUrls ?? []).some((u) => u.toLowerCase() === lower) ||
    (s.azureDevOps?.excludedUrls ?? []).some((u) => u.toLowerCase() === lower) ||
    (s.gitlab?.excludedUrls ?? []).some((u) => u.toLowerCase() === lower)
  );
}

export function loadSecrets(): PersistedSecrets {
  const raw = readJsonIfFresh<PersistedSecrets>(secretsPath(), secretsCache) ?? {};
  return raw;
}

export function saveSecrets(next: PersistedSecrets): void {
  atomicWriteJson(secretsPath(), next);
  secretsCache.delete(secretsPath());
}

/** Read a decrypted secret, or undefined if not stored. */
export function readSecret(key: keyof PersistedSecrets): string | undefined {
  const all = loadSecrets();
  const blob = all[key];
  if (!blob || !isEncryptedSecret(blob)) return undefined;
  try {
    return decryptSecret(blob);
  } catch (err) {
    logger.error(`[settings] Failed to decrypt ${key}:`, (err as Error).message);
    return undefined;
  }
}

/** Encrypt and persist a single secret; pass undefined to delete it. */
export function writeSecret(key: keyof PersistedSecrets, plaintext: string | undefined): void {
  const all = loadSecrets();
  if (plaintext === undefined || plaintext === '') {
    delete all[key];
  } else {
    all[key] = encryptSecret(plaintext);
  }
  saveSecrets(all);
}

/** Update a subset of settings (deep merge for known sub-objects). */
export function patchSettings(patch: PersistedSettings): PersistedSettings {
  const current = loadSettings();
  const next: PersistedSettings = { ...current, ...patch };

  if (patch.github !== undefined) {
    next.github = { ...(current.github ?? {}), ...patch.github };
  }
  if (patch.azureDevOps !== undefined) {
    next.azureDevOps = { ...(current.azureDevOps ?? {}), ...patch.azureDevOps };
  }
  if (patch.gitlab !== undefined) {
    next.gitlab = { ...(current.gitlab ?? {}), ...patch.gitlab };
  }
  if (patch.smtp !== undefined) {
    next.smtp = { ...(current.smtp ?? {}), ...patch.smtp };
  }
  if (patch.ui !== undefined) {
    next.ui = { ...(current.ui ?? {}), ...patch.ui };
  }

  saveSettings(next);
  return next;
}
