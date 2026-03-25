export interface ProviderConfig {
  pat: string;
  patExpires: Date;
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
  backupMode: 'option1' | 'option2';
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
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer value: "${value}"`);
  }
  return parsed;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is not a valid ISO 8601 date: "${value}"`);
  }
  return date;
}

function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

function loadProvider(
  patKey: string,
  expiresKey: string,
  name: string,
  env: Record<string, string | undefined>,
): ProviderConfig | undefined {
  const pat = env[patKey];
  const expires = env[expiresKey];

  if (!pat && !expires) return undefined;

  if (pat && !expires) {
    throw new Error(`${expiresKey} is required when ${patKey} is set`);
  }
  if (!pat && expires) {
    throw new Error(`${patKey} is required when ${expiresKey} is set`);
  }

  return {
    pat: pat!,
    patExpires: parseDate(expires!, `${name} PAT expiration (${expiresKey})`),
  };
}

function loadSmtp(env: Record<string, string | undefined>): SmtpConfig | undefined {
  const fields = {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
    to: env.SMTP_TO,
  };

  const setFields = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '');
  if (setFields.length === 0) return undefined;

  const requiredKeys: (keyof typeof fields)[] = ['host', 'user', 'pass', 'from', 'to'];
  const missing = requiredKeys.filter((k) => !fields[k]);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete SMTP configuration. Missing: ${missing.map((k) => `SMTP_${k.toUpperCase()}`).join(', ')}`,
    );
  }

  return {
    host: fields.host!,
    port: parseInteger(fields.port, 587),
    user: fields.user!,
    pass: fields.pass!,
    from: fields.from!,
    to: fields.to!,
  };
}

/** Parse and validate configuration from environment variables. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const errors: string[] = [];

  // Providers
  let github: ProviderConfig | undefined;
  let azureDevOps: ProviderConfig | undefined;

  try {
    github = loadProvider('GITHUB_PAT', 'GITHUB_PAT_EXPIRES', 'GitHub', env);
  } catch (e) {
    errors.push((e as Error).message);
  }

  try {
    azureDevOps = loadProvider('AZUREDEVOPS_PAT', 'AZUREDEVOPS_PAT_EXPIRES', 'Azure DevOps', env);
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (!github && !azureDevOps && errors.length === 0) {
    errors.push(
      'At least one provider must be configured. Set GITHUB_PAT/GITHUB_PAT_EXPIRES or AZUREDEVOPS_PAT/AZUREDEVOPS_PAT_EXPIRES.',
    );
  }

  // Backup mode
  const rawBackupMode = env.BACKUP_MODE ?? 'option1';
  if (rawBackupMode !== 'option1' && rawBackupMode !== 'option2') {
    errors.push(`BACKUP_MODE must be "option1" or "option2", got "${rawBackupMode}"`);
  }
  const backupMode = (rawBackupMode === 'option2' ? 'option2' : 'option1') as AppConfig['backupMode'];

  // Cron schedule
  const cronSchedule = env.CRON_SCHEDULE ?? '0 2 * * *';
  if (!isValidCron(cronSchedule)) {
    errors.push(`CRON_SCHEDULE is not a valid cron expression (expected 5-6 fields): "${cronSchedule}"`);
  }

  // SMTP
  let smtp: SmtpConfig | undefined;
  try {
    smtp = loadSmtp(env);
  } catch (e) {
    errors.push((e as Error).message);
  }

  // Scalars
  let patExpiryWarnDays = 14;
  try {
    patExpiryWarnDays = parseInteger(env.PAT_EXPIRY_WARN_DAYS, 14);
  } catch {
    errors.push(`PAT_EXPIRY_WARN_DAYS must be a valid integer, got "${env.PAT_EXPIRY_WARN_DAYS}"`);
  }

  const notifyOnSuccess = parseBoolean(env.NOTIFY_ON_SUCCESS, false);

  // Warn when email notifications are enabled but SMTP is not configured
  if (notifyOnSuccess && !smtp) {
    console.warn('[config] NOTIFY_ON_SUCCESS is enabled but SMTP is not configured — notifications will not be sent.');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
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

let cached: AppConfig | undefined;

/** Return a cached singleton config, loading from environment on first call. */
export function getConfig(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}
