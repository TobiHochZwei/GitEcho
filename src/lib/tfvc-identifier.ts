/**
 * Shared helpers for GitEcho's canonical TFVC identifiers.
 *
 * TFVC (Team Foundation Version Control) sources have no clone URL like Git,
 * so GitEcho assigns them a synthetic, internal identifier that encodes the
 * organization, project, and server path. The format is:
 *
 *   tfvc://dev.azure.com/<org>/<project>?path=$/<project>/<serverPath>
 *
 * This identifier is internal to GitEcho and must NOT be treated as a clone
 * URL. It exists purely to give TFVC rows a stable, unique key that cannot
 * collide with Git `_git` URLs.
 */

export interface TfvcRef {
  /** The full canonical identifier, e.g. `tfvc://dev.azure.com/org/proj?path=$/proj/Main`. */
  url: string;
  /** Azure DevOps organization name. */
  org: string;
  /** Azure DevOps project name. */
  project: string;
  /** TFVC server path, e.g. `$/Project/Main`. */
  path: string;
}

/**
 * Parse a canonical TFVC identifier. Returns `undefined` when the input is
 * not a well-formed `tfvc://dev.azure.com/...` identifier with a `path` query.
 */
export function parseTfvcIdentifier(input: string): TfvcRef | undefined {
  if (!input.startsWith('tfvc://')) return undefined;
  try {
    const u = new URL(input);
    if (u.host.toLowerCase() !== 'dev.azure.com') return undefined;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return undefined;
    const org = decodeURIComponent(parts[0]);
    const project = decodeURIComponent(parts[1]);
    const p = u.searchParams.get('path');
    if (!p) return undefined;
    const path = decodeURIComponent(p);
    if (!org || !project || !path) return undefined;
    return { url: input, org, project, path };
  } catch {
    return undefined;
  }
}

/**
 * Build a canonical TFVC identifier from its components. Trailing slashes on
 * the server path are trimmed so that `$/Project/Main` and `$/Project/Main/`
 * produce the same identifier.
 */
export function buildTfvcIdentifier(org: string, project: string, serverPath: string): string {
  const normalized = serverPath.trim().replace(/\/+$/, '');
  return (
    `tfvc://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `?path=${encodeURIComponent(normalized)}`
  );
}

/**
 * Derive a human-friendly display name from a TFVC server path. Falls back to
 * the project name when the path has no trailing segment (e.g. `$/`).
 */
export function tfvcDisplayName(serverPath: string, fallbackProject: string): string {
  const parts = serverPath.split('/').filter((seg) => seg && seg !== '$');
  const last = parts.length > 0 ? parts[parts.length - 1] : '';
  return last || fallbackProject;
}

/**
 * Sanitize a string for safe use as a file/directory name. Collapses any run
 * of disallowed characters to a single underscore and trims leading/trailing
 * underscores. Returns `tfvc` when nothing usable remains.
 */
export function safeTfvcName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'tfvc';
}
