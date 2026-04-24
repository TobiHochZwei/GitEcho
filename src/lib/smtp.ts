import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getConfig } from './config.js';
import { logger, redactSecrets } from './logger.js';

export interface BackupSummary {
  startedAt: string;
  completedAt: string;
  totalRepos: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  backupMode: string;
  failures?: Array<{ repo: string; error: string }>;
}

export interface PatWarning {
  provider: string;
  expiresOn: string;
  daysRemaining: number;
  expired: boolean;
}

export interface BackupCycleReport {
  summary: BackupSummary;
  unavailable: Array<{ repo: string; url: string; error: string }>;
  newRepos: Array<{
    provider: string;
    providerDisplay: string;
    repos: Array<{ url: string; owner: string; name: string }>;
  }>;
  patWarnings: PatWarning[];
  /** When set, the cycle ended with an uncaught error (e.g. engine crash). */
  criticalError?: { message: string; context?: string };
}

let transporter: Transporter | undefined;

function getTransporter(): Transporter | undefined {
  if (transporter) return transporter;

  const { smtp } = getConfig();
  if (!smtp) return undefined;

  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  return transporter;
}

// ── HTML helpers ──────────────────────────────────────────────────────

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#24292f;padding:20px 24px">
            <h1 style="margin:0;font-size:20px;color:#ffffff">🔄 GitEcho</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px">
            <h2 style="margin:0 0 16px;font-size:18px;color:#24292f">${title}</h2>
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f6f8fa;font-size:12px;color:#656d76;text-align:center">
            Sent by GitEcho &mdash; automated Git backup
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Send helper ──────────────────────────────────────────────────────

export async function sendNotification(subject: string, htmlBody: string): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    logger.debug('[smtp] SMTP not configured — skipping notification');
    return;
  }

  const { smtp } = getConfig();

  try {
    await transport.sendMail({
      from: smtp!.from,
      to: smtp!.to,
      subject: redactSecrets(subject),
      html: redactSecrets(htmlBody),
    });
    logger.info(`[smtp] Sent: ${subject}`);
  } catch (err) {
    logger.error(`[smtp] Failed to send email "${subject}":`, err);
  }
}

// ── Public notification functions ────────────────────────────────────

export async function notifyNewRepositories(
  providerDisplayName: string,
  repos: Array<{ url: string; owner: string; name: string }>,
): Promise<void> {
  if (repos.length === 0) return;

  const rows = repos
    .map((r) => {
      const label = `${escapeHtml(r.owner)}/${escapeHtml(r.name)}`;
      const href = escapeHtml(r.url);
      return `<li style="margin-bottom:6px"><a href="${href}" style="color:#0969da;text-decoration:none">${label}</a></li>`;
    })
    .join('');

  const body = `
    <p style="margin:0 0 12px;font-size:14px;color:#24292f">
      ${repos.length} new repository${repos.length === 1 ? '' : 'ies'} discovered for
      <strong>${escapeHtml(providerDisplayName)}</strong> and added to GitEcho.
    </p>
    <ul style="padding-left:20px;margin:12px 0;font-size:14px;color:#24292f">${rows}</ul>
    <p style="margin:16px 0 0;font-size:13px;color:#656d76">
      They will be included in the next backup cycle.
    </p>`;

  await sendNotification(
    `🆕 GitEcho: ${repos.length} new ${providerDisplayName} repo${repos.length === 1 ? '' : 's'} discovered`,
    layout('New repositories discovered', body),
  );
}

export async function notifyCriticalError(error: string, context?: string): Promise<void> {
  const contextBlock = context
    ? `<p style="margin:12px 0 0;font-size:14px;color:#656d76">${escapeHtml(context)}</p>`
    : '';

  const body = `
    <div style="background:#ffe2e0;border-left:4px solid #cf222e;padding:16px;border-radius:4px;margin-bottom:16px">
      <p style="margin:0;font-size:14px;color:#cf222e;font-weight:600">A critical error occurred during the backup process:</p>
    </div>
    <pre style="background:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;font-size:13px;color:#24292f;border:1px solid #d0d7de">${escapeHtml(error)}</pre>
    ${contextBlock}
    <p style="margin:16px 0 0;font-size:14px;color:#656d76">Please investigate immediately.</p>`;

  await sendNotification('🚨 GitEcho: Critical error', layout('Critical Error', body));
}

export async function notifyBackupSuccess(summary: BackupSummary): Promise<void> {
  const { notifyOnSuccess } = getConfig();
  if (!notifyOnSuccess) {
    logger.debug('[smtp] NOTIFY_ON_SUCCESS is disabled — skipping success notification');
    return;
  }

  const started = new Date(summary.startedAt);
  const completed = new Date(summary.completedAt);
  const durationMs = completed.getTime() - started.getTime();
  const durationSec = Math.round(durationMs / 1000);
  const durationStr = durationSec >= 60
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : `${durationSec}s`;

  const failureRows = summary.failures?.length
    ? summary.failures
        .map(
          (f) =>
            `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(f.repo)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#cf222e">${escapeHtml(f.error)}</td>
            </tr>`,
        )
        .join('')
    : '';

  const failureTable = failureRows
    ? `<h3 style="margin:20px 0 8px;font-size:15px;color:#cf222e">Failed Repositories</h3>
       <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse">
         <tr style="background:#f6f8fa">
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Repository</th>
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Error</th>
         </tr>
         ${failureRows}
       </table>`
    : '';

  const statusColor = summary.failedCount > 0 ? '#bf8700' : '#1a7f37';
  const statusLabel = summary.failedCount > 0 ? 'Completed with errors' : 'Completed successfully';

  const body = `
    <div style="background:${summary.failedCount > 0 ? '#fff8c5' : '#dafbe1'};border-left:4px solid ${statusColor};padding:12px 16px;border-radius:4px;margin-bottom:16px">
      <span style="font-size:14px;font-weight:600;color:${statusColor}">${statusLabel}</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
      <tr style="background:#f6f8fa">
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Metric</th>
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Value</th>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Total Repositories</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;font-weight:600">${summary.totalRepos}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Successful</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#1a7f37;font-weight:600">${summary.successCount}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Failed</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:${summary.failedCount > 0 ? '#cf222e' : '#24292f'};font-weight:600">${summary.failedCount}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Skipped</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${summary.skippedCount}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Backup Mode</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(summary.backupMode)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Duration</td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${durationStr}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;font-size:13px">Started</td>
        <td style="padding:8px 12px;font-size:13px">${escapeHtml(summary.startedAt)}</td>
      </tr>
    </table>
    ${failureTable}`;

  await sendNotification('✅ GitEcho: Backup completed', layout('Backup Summary', body));
}

export async function notifyUnavailableRepos(
  unavailable: Array<{ repo: string; url: string; error: string }>,
): Promise<void> {
  if (unavailable.length === 0) return;

  const rows = unavailable
    .map((u) => {
      const href = escapeHtml(u.url);
      const label = escapeHtml(u.repo);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px"><a href="${href}" style="color:#0969da;text-decoration:none">${label}</a></td>
        <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#cf222e">${escapeHtml(u.error)}</td>
      </tr>`;
    })
    .join('');

  const body = `
    <div style="background:#ffe2e0;border-left:4px solid #cf222e;padding:16px;border-radius:4px;margin-bottom:16px">
      <p style="margin:0;font-size:14px;color:#cf222e;font-weight:600">
        ${unavailable.length} repository${unavailable.length === 1 ? '' : 'ies'} could not be reached upstream during the latest backup run.
      </p>
    </div>
    <p style="margin:0 0 12px;font-size:14px;color:#24292f">
      The repositories below appear to be deleted, renamed, made private, or no longer accessible with the current credentials. The backup run continued for all other repositories. Existing local backups are kept untouched.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
      <tr style="background:#f6f8fa">
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Repository</th>
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Error</th>
      </tr>
      ${rows}
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#656d76">
      Review them in the Repositories page and remove or update the URL in <code>repos.txt</code> if appropriate.
    </p>`;

  await sendNotification(
    `🚨 GitEcho: ${unavailable.length} upstream repo${unavailable.length === 1 ? '' : 's'} unavailable`,
    layout('Upstream repositories unavailable', body),
  );
}

export async function checkAndNotifyPatExpiry(): Promise<void> {
  const config = getConfig();
  const now = new Date();

  const providers: Array<{ name: string; config: { patExpires: Date } | undefined }> = [
    { name: 'GitHub', config: config.github },
    { name: 'Azure DevOps', config: config.azureDevOps },
    { name: 'GitLab', config: config.gitlab },
  ];

  for (const provider of providers) {
    if (!provider.config) continue;

    const expires = provider.config.patExpires;
    const diffMs = expires.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysRemaining <= 0) {
      const body = `
        <div style="background:#ffe2e0;border-left:4px solid #cf222e;padding:16px;border-radius:4px;margin-bottom:16px">
          <p style="margin:0;font-size:14px;font-weight:600;color:#cf222e">
            The ${escapeHtml(provider.name)} Personal Access Token has expired!
          </p>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;font-weight:600">Provider</td>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(provider.name)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:13px;font-weight:600">Expired On</td>
            <td style="padding:8px 12px;font-size:13px;color:#cf222e">${expires.toISOString().split('T')[0]}</td>
          </tr>
        </table>
        <p style="font-size:14px;color:#24292f">
          Backups for ${escapeHtml(provider.name)} will fail until the PAT is renewed. Please generate a new token and update the <code>PAT</code> and <code>PAT_EXPIRES</code> environment variables.
        </p>`;

      await sendNotification(
        `🚨 GitEcho: PAT expired — ${provider.name}`,
        layout('PAT Expired', body),
      );
    } else if (daysRemaining <= config.patExpiryWarnDays) {
      const body = `
        <div style="background:#fff8c5;border-left:4px solid #bf8700;padding:16px;border-radius:4px;margin-bottom:16px">
          <p style="margin:0;font-size:14px;font-weight:600;color:#bf8700">
            The ${escapeHtml(provider.name)} Personal Access Token will expire soon.
          </p>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;font-weight:600">Provider</td>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(provider.name)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;font-weight:600">Expires On</td>
            <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#bf8700">${expires.toISOString().split('T')[0]}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:13px;font-weight:600">Days Remaining</td>
            <td style="padding:8px 12px;font-size:13px;color:#bf8700;font-weight:600">${daysRemaining}</td>
          </tr>
        </table>
        <p style="font-size:14px;color:#24292f">
          Please generate a new ${escapeHtml(provider.name)} token and update the <code>PAT</code> and <code>PAT_EXPIRES</code> environment variables before it expires.
        </p>`;

      await sendNotification(
        `⚠️ GitEcho: PAT expiring soon — ${provider.name}`,
        layout('PAT Expiring Soon', body),
      );
    }
  }
}

// ── Consolidated cycle report ────────────────────────────────────────
//
// Collect PAT expiry state without sending any email. The scheduler folds
// the result into a single consolidated backup-cycle report so operators
// don't get a mailbox-full of partial notifications per run.
export function collectPatExpiryWarnings(): PatWarning[] {
  const config = getConfig();
  const now = new Date();
  const warnings: PatWarning[] = [];

  const providers: Array<{ name: string; config: { patExpires: Date } | undefined }> = [
    { name: 'GitHub', config: config.github },
    { name: 'Azure DevOps', config: config.azureDevOps },
    { name: 'GitLab', config: config.gitlab },
  ];

  for (const provider of providers) {
    if (!provider.config) continue;
    const expires = provider.config.patExpires;
    const diffMs = expires.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysRemaining <= 0) {
      warnings.push({
        provider: provider.name,
        expiresOn: expires.toISOString().split('T')[0],
        daysRemaining,
        expired: true,
      });
    } else if (daysRemaining <= config.patExpiryWarnDays) {
      warnings.push({
        provider: provider.name,
        expiresOn: expires.toISOString().split('T')[0],
        daysRemaining,
        expired: false,
      });
    }
  }

  return warnings;
}

/**
 * Send exactly ONE email per backup cycle summarising everything that
 * happened: PAT warnings, newly discovered repos, upstream-unavailable
 * repos, failed repos, and overall success stats. All user-supplied fields
 * are HTML-escaped, and the SMTP send path additionally runs redactSecrets()
 * on the subject and body so PATs / passwords cannot leak.
 */
export async function notifyBackupCycleReport(report: BackupCycleReport): Promise<void> {
  const { summary, unavailable, newRepos, patWarnings, criticalError } = report;
  const { notifyOnSuccess } = getConfig();

  // Decide whether to send at all. Always send when something needs attention
  // (failures, unavailable repos, PAT issues, new repos, critical errors).
  const hasAttentionItems =
    summary.failedCount > 0 ||
    unavailable.length > 0 ||
    patWarnings.length > 0 ||
    newRepos.length > 0 ||
    Boolean(criticalError);

  if (!hasAttentionItems && !notifyOnSuccess) {
    logger.debug('[smtp] Cycle completed cleanly and NOTIFY_ON_SUCCESS=false — no email sent');
    return;
  }

  const started = new Date(summary.startedAt);
  const completed = new Date(summary.completedAt);
  const durationSec = Math.max(0, Math.round((completed.getTime() - started.getTime()) / 1000));
  const durationStr =
    durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

  // ── Status banner ──────────────────────────────────────────────
  let bannerColor = '#1a7f37';
  let bannerBg = '#dafbe1';
  let statusLabel = 'Completed successfully';
  let subjectIcon = '✅';

  if (criticalError) {
    bannerColor = '#cf222e';
    bannerBg = '#ffe2e0';
    statusLabel = 'Cycle crashed';
    subjectIcon = '🚨';
  } else if (summary.failedCount > 0 && summary.successCount === 0) {
    bannerColor = '#cf222e';
    bannerBg = '#ffe2e0';
    statusLabel = 'All repositories failed';
    subjectIcon = '🚨';
  } else if (summary.failedCount > 0 || unavailable.length > 0 || patWarnings.some((w) => w.expired)) {
    bannerColor = '#bf8700';
    bannerBg = '#fff8c5';
    statusLabel = 'Completed with issues';
    subjectIcon = '⚠️';
  }

  const banner = `
    <div style="background:${bannerBg};border-left:4px solid ${bannerColor};padding:12px 16px;border-radius:4px;margin-bottom:16px">
      <span style="font-size:14px;font-weight:600;color:${bannerColor}">${statusLabel}</span>
    </div>`;

  // ── Critical error (optional) ──────────────────────────────────
  const criticalBlock = criticalError
    ? `<h3 style="margin:20px 0 8px;font-size:15px;color:#cf222e">Critical error</h3>
       <pre style="background:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;font-size:13px;color:#24292f;border:1px solid #d0d7de;white-space:pre-wrap;word-break:break-word">${escapeHtml(criticalError.message)}</pre>
       ${
         criticalError.context
           ? `<pre style="background:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;font-size:12px;color:#656d76;border:1px solid #d0d7de;white-space:pre-wrap;word-break:break-word">${escapeHtml(criticalError.context)}</pre>`
           : ''
       }`
    : '';

  // ── Summary table ──────────────────────────────────────────────
  const summaryTable = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
      <tr style="background:#f6f8fa">
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Metric</th>
        <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Value</th>
      </tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Total repositories</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;font-weight:600">${summary.totalRepos}</td></tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Successful</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#1a7f37;font-weight:600">${summary.successCount}</td></tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Failed</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:${summary.failedCount > 0 ? '#cf222e' : '#24292f'};font-weight:600">${summary.failedCount}</td></tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Unavailable upstream</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:${unavailable.length > 0 ? '#bf8700' : '#24292f'};font-weight:600">${unavailable.length}</td></tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Backup mode</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(summary.backupMode)}</td></tr>
      <tr><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">Duration</td><td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${durationStr}</td></tr>
      <tr><td style="padding:8px 12px;font-size:13px">Started</td><td style="padding:8px 12px;font-size:13px">${escapeHtml(summary.startedAt)}</td></tr>
    </table>`;

  // ── PAT warnings ───────────────────────────────────────────────
  const patBlock = patWarnings.length
    ? `<h3 style="margin:20px 0 8px;font-size:15px;color:#bf8700">PAT expiry</h3>
       <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
         <tr style="background:#f6f8fa">
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Provider</th>
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Expires on</th>
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Status</th>
         </tr>
         ${patWarnings
           .map(
             (w) =>
               `<tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(w.provider)}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(w.expiresOn)}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:${w.expired ? '#cf222e' : '#bf8700'};font-weight:600">${w.expired ? 'EXPIRED' : `${w.daysRemaining} day${w.daysRemaining === 1 ? '' : 's'} remaining`}</td>
                </tr>`,
           )
           .join('')}
       </table>`
    : '';

  // ── New repositories ───────────────────────────────────────────
  const newReposBlock = newRepos.length
    ? newRepos
        .map(
          (entry) =>
            `<h3 style="margin:20px 0 8px;font-size:15px;color:#0969da">New ${escapeHtml(entry.providerDisplay)} repositories (${entry.repos.length})</h3>
             <ul style="padding-left:20px;margin:8px 0 16px;font-size:14px;color:#24292f">
               ${entry.repos
                 .map(
                   (r) =>
                     `<li style="margin-bottom:4px"><a href="${escapeHtml(r.url)}" style="color:#0969da;text-decoration:none">${escapeHtml(r.owner)}/${escapeHtml(r.name)}</a></li>`,
                 )
                 .join('')}
             </ul>`,
        )
        .join('')
    : '';

  // ── Failures ───────────────────────────────────────────────────
  const failures = summary.failures ?? [];
  const failureBlock = failures.length
    ? `<h3 style="margin:20px 0 8px;font-size:15px;color:#cf222e">Failed repositories (${failures.length})</h3>
       <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
         <tr style="background:#f6f8fa">
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Repository</th>
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Error</th>
         </tr>
         ${failures
           .map(
             (f) =>
               `<tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px">${escapeHtml(f.repo)}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#cf222e;word-break:break-word">${escapeHtml(f.error)}</td>
                </tr>`,
           )
           .join('')}
       </table>`
    : '';

  // ── Unavailable upstream ───────────────────────────────────────
  const unavailableBlock = unavailable.length
    ? `<h3 style="margin:20px 0 8px;font-size:15px;color:#bf8700">Upstream unavailable (${unavailable.length})</h3>
       <p style="margin:0 0 8px;font-size:13px;color:#656d76">
         These repositories appear deleted, renamed, made private, or no longer accessible with the current credentials. Existing local backups are kept untouched.
       </p>
       <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d0d7de;border-radius:6px;border-collapse:collapse;margin-bottom:16px">
         <tr style="background:#f6f8fa">
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Repository</th>
           <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid #d0d7de">Error</th>
         </tr>
         ${unavailable
           .map(
             (u) =>
               `<tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px"><a href="${escapeHtml(u.url)}" style="color:#0969da;text-decoration:none">${escapeHtml(u.repo)}</a></td>
                  <td style="padding:8px 12px;border-bottom:1px solid #d0d7de;font-size:13px;color:#bf8700;word-break:break-word">${escapeHtml(u.error)}</td>
                </tr>`,
           )
           .join('')}
       </table>`
    : '';

  const body = `
    ${banner}
    ${criticalBlock}
    ${summaryTable}
    ${patBlock}
    ${failureBlock}
    ${unavailableBlock}
    ${newReposBlock}`;

  // Build a compact, informative subject line.
  const parts: string[] = [];
  parts.push(`${summary.successCount}/${summary.totalRepos} ok`);
  if (summary.failedCount > 0) parts.push(`${summary.failedCount} failed`);
  if (unavailable.length > 0) parts.push(`${unavailable.length} unavailable`);
  if (newRepos.length > 0) {
    const newTotal = newRepos.reduce((a, e) => a + e.repos.length, 0);
    parts.push(`${newTotal} new`);
  }
  if (patWarnings.length > 0) parts.push('PAT');
  const subject = `${subjectIcon} GitEcho backup — ${parts.join(', ')}`;

  await sendNotification(subject, layout('Backup cycle report', body));
}
