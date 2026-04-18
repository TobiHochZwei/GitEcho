// Configuration loader.
//
// Layers (lowest precedence first):
//   1. Built-in defaults
//   2. Environment variables
//   3. /config/settings.json (managed via the Settings UI)
//   4. /config/secrets.json  (encrypted PATs / SMTP password)
//
// loadConfig() returns a partial AppConfig — providers and SMTP may be
// undefined when nothing has been configured yet. Callers that strictly
// require a provider should call isBackupCapable().

import { loadSettings, readSecret } from './settings.js';
import type { DiscoveryFilterSettings } from './settings.js';

export interface ProviderConfig {
  pat: string;
  patExpires: Date;
  /** Discover all PAT-visible repos in addition to repos.txt. Defaults to true. */
  autoDiscover?: boolean;
  /** Only used by Azure DevOps: organization (bare name or full URL). */
  org?: string;
  /** Append newly-discovered URLs to /config/repos.txt. Defaults to false. */
  autoAppendToReposTxt?: boolean;
  /** Notify by email when previously-unseen repos are discovered. Defaults to true. */
  notifyOnNewRepo?: boolean;
  /** Filters applied during discovery. */
  filters?: DiscoveryFilterSettings;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export interface AppConfig {
  github?: ProviderConfig;
  azureDevOps?: ProviderConfig;
  backupMode: 'option1' | 'option2' | 'option3';
  cronSchedule: string;
  smtp?: SmtpConfig;
  notifyOnSuccess: boolean;
  patExpiryWarnDays: number;
  dataDir: string;
  configDir: string;
  backupsDir: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

function parseDateOrUndefined(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

function loadProvider(
  patEnv: string | undefined,
  patExpiresEnv: string | undefined,
  storedPat: string | undefined,
  storedExpires: string | undefined,
  storedAutoDiscover: boolean | undefined,
  storedOrg: string | undefined,
  envOrg: string | undefined,
  storedAutoAppend: boolean | undefined,
  storedNotifyOnNew: boolean | undefined,
  storedFilters: DiscoveryFilterSettings | undefined,
): ProviderConfig | undefined {
  // Settings/secrets win when present, else fall back to env
  const pat = storedPat ?? patEnv;
  const expiresRaw = storedExpires ?? patExpiresEnv;
  const expires = parseDateOrUndefined(expiresRaw);

  if (!pat || !expires) return undefined;

  return {
    pat,
    patExpires: expires,
    autoDiscover: storedAutoDiscover,
    org: storedOrg ?? envOrg,
    autoAppendToReposTxt: storedAutoAppend,
    notifyOnNewRepo: storedNotifyOnNew,
    filters: storedFilters,
  };
}

function loadSmtpFromLayers(env: Record<string, string | undefined>): SmtpConfig | undefined {
  const settings = loadSettings();
  const s = settings.smtp ?? {};
  const host = s.host ?? env.SMTP_HOST;
  const portRaw = s.port ?? parseInteger(env.SMTP_PORT, 587);
  const user = s.user ?? env.SMTP_USER;
  const from = s.from ?? env.SMTP_FROM;
  const to = s.to ?? env.SMTP_TO;
  const pass = readSecret('smtp.pass') ?? env.SMTP_PASS;

  if (!host || !user || !pass || !from || !to) return undefined;

  return {
    host,
    port: typeof portRaw === 'number' ? portRaw : 587,
    user,
    pass,
    from,
    to,
  };
}

/** Load and merge configuration from env + settings.json + secrets.json. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const settings = loadSettings();

  let github: ProviderConfig | undefined;
  let azureDevOps: ProviderConfig | undefined;

  try {
    github = loadProvider(
      env.GITHUB_PAT,
      env.GITHUB_PAT_EXPIRES,
      readSecret('github.pat'),
      settings.github?.patExpires,
      settings.github?.autoDiscover,
      undefined,
      undefined,
      settings.github?.autoAppendToReposTxt,
      settings.github?.notifyOnNewRepo,
      settings.github?.filters,
    );
  } catch (err) {
    console.error('[config] Failed to load GitHub provider:', (err as Error).message);
  }

  try {
    azureDevOps = loadProvider(
      env.AZUREDEVOPS_PAT,
      env.AZUREDEVOPS_PAT_EXPIRES,
      readSecret('azureDevOps.pat'),
      settings.azureDevOps?.patExpires,
      settings.azureDevOps?.autoDiscover,
      settings.azureDevOps?.org,
      env.AZUREDEVOPS_ORG,
      settings.azureDevOps?.autoAppendToReposTxt,
      settings.azureDevOps?.notifyOnNewRepo,
      settings.azureDevOps?.filters,
    );
  } catch (err) {
    console.error('[config] Failed to load Azure DevOps provider:', (err as Error).message);
  }

  const rawBackupMode = settings.backupMode ?? env.BACKUP_MODE ?? 'option1';
  const backupMode: AppConfig['backupMode'] =
    rawBackupMode === 'option2' || rawBackupMode === 'option3' ? rawBackupMode : 'option1';

  const cronCandidate = settings.cronSchedule ?? env.CRON_SCHEDULE ?? '0 2 * * *';
  const cronSchedule = isValidCron(cronCandidate) ? cronCandidate : '0 2 * * *';

  const smtp = loadSmtpFromLayers(env);

  const patExpiryWarnDays = settings.patExpiryWarnDays ?? parseInteger(env.PAT_EXPIRY_WARN_DAYS, 14);
  const notifyOnSuccess =
    settings.notifyOnSuccess !== undefined
      ? Boolean(settings.notifyOnSuccess)
      : parseBoolean(env.NOTIFY_ON_SUCCESS, false);

  if (notifyOnSuccess && !smtp) {
    console.warn(
      '[config] NOTIFY_ON_SUCCESS is enabled but SMTP is not fully configured — notifications will not be sent.',
    );
  }

  return {
    github,
    azureDevOps,
    backupMode,
    cronSchedule,
    smtp,
    notifyOnSuccess,
    patExpiryWarnDays,
    dataDir: env.DATA_DIR ?? '/data',
    configDir: env.CONFIG_DIR ?? '/config',
    backupsDir: env.BACKUPS_DIR ?? '/backups',
  };
}

/** Re-load config on every call so UI changes propagate without restart. */
export function getConfig(): AppConfig {
  return loadConfig();
}

/** True when at least one provider is fully configured. */
export function isBackupCapable(config: AppConfig = getConfig()): boolean {
  return Boolean(config.github || config.azureDevOps);
}
