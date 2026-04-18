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
   * both GitHub and Azure DevOps. Defaults to true.
   */
  autoDiscover?: boolean;
  org?: string; // Azure DevOps only
  /** Append newly-discovered repository URLs to /config/repos.txt. Defaults to false. */
  autoAppendToReposTxt?: boolean;
  /** Send an SMTP notification when previously-unseen repos are discovered. Defaults to true. */
  notifyOnNewRepo?: boolean;
  /** Filters applied to the discovery result before persistence. */
  filters?: DiscoveryFilterSettings;
}

export interface SmtpSettings {
  host?: string;
  port?: number;
  user?: string;
  from?: string;
  to?: string;
}

export interface PersistedSettings {
  github?: ProviderSettings;
  azureDevOps?: ProviderSettings;
  backupMode?: 'option1' | 'option2' | 'option3';
  cronSchedule?: string;
  smtp?: SmtpSettings;
  notifyOnSuccess?: boolean;
  patExpiryWarnDays?: number;
}

export interface PersistedSecrets {
  'github.pat'?: EncryptedSecret;
  'azureDevOps.pat'?: EncryptedSecret;
  'smtp.pass'?: EncryptedSecret;
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
    console.error(`[settings] Failed to parse ${path}:`, err);
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
  return readJsonIfFresh<PersistedSettings>(settingsPath(), settingsCache) ?? {};
}

export function saveSettings(next: PersistedSettings): void {
  atomicWriteJson(settingsPath(), next);
  settingsCache.delete(settingsPath());
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
    console.error(`[settings] Failed to decrypt ${key}:`, (err as Error).message);
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
  if (patch.smtp !== undefined) {
    next.smtp = { ...(current.smtp ?? {}), ...patch.smtp };
  }

  saveSettings(next);
  return next;
}
