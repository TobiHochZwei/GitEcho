import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getConfig } from './config.js';

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
    console.debug('[smtp] SMTP not configured — skipping notification');
    return;
  }

  const { smtp } = getConfig();

  try {
    await transport.sendMail({
      from: smtp!.from,
      to: smtp!.to,
      subject,
      html: htmlBody,
    });
    console.info(`[smtp] Sent: ${subject}`);
  } catch (err) {
    console.error(`[smtp] Failed to send email "${subject}":`, err);
  }
}

// ── Public notification functions ────────────────────────────────────

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
    console.debug('[smtp] NOTIFY_ON_SUCCESS is disabled — skipping success notification');
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

export async function checkAndNotifyPatExpiry(): Promise<void> {
  const config = getConfig();
  const now = new Date();

  const providers: Array<{ name: string; config: { patExpires: Date } | undefined }> = [
    { name: 'GitHub', config: config.github },
    { name: 'Azure DevOps', config: config.azureDevOps },
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
