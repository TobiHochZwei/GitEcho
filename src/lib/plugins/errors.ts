// Typed error for the case where the upstream repository is not (or no
// longer) reachable in a way that retries won't fix on their own — repository
// was deleted, renamed, made private, or the PAT no longer has access.
//
// The backup engine treats this distinctly from generic transient errors so
// that the dashboard, notifications, and run summary can surface it
// separately from "real" failures.

export class UpstreamUnavailableError extends Error {
  readonly kind = 'upstream-unavailable' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'UpstreamUnavailableError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isUpstreamUnavailable(err: unknown): err is UpstreamUnavailableError {
  return err instanceof UpstreamUnavailableError;
}

// Patterns covering the three big providers' "repo gone / no access" stderr
// messages from `git`, `gh`, and `az`. Kept intentionally broad — false
// positives would only mean we send a misleading notification, while a false
// negative would silently hide a deleted repo.
const UNAVAILABLE_PATTERNS: RegExp[] = [
  /repository not found/i,
  /could not read from remote repository/i,
  /remote: not found/i,
  /remote: repository .*(?:disabled|archived|locked)/i,
  /authentication failed/i,
  /permission to .* denied/i,
  /\b(?:403|404)\b/i,
  /access denied/i,
  /the requested url returned error: (?:403|404)/i,
  /fatal: unable to access/i,
  /could not resolve host/i, // DNS — provider host typo or org-wide outage; treat as unavailable for surfacing
  // Azure DevOps specific
  /\bTF401019\b/, // Git repository does not exist or you do not have permissions
  /\bTF400813\b/, // permission denied
  /\bTF200016\b/, // project does not exist
  /\bVS800075\b/, // project not found
  /\bTF401174\b/, // repo deleted/disabled
];

export function classifyGitError(stderr: string | undefined | null): boolean {
  if (!stderr) return false;
  return UNAVAILABLE_PATTERNS.some((re) => re.test(stderr));
}

// Convenience: if the error matches the unavailable patterns, throw the
// typed error; otherwise rethrow the original error untouched. Use inside
// catch blocks of clone/pull paths.
export function rethrowAsUnavailableIfMatch(err: unknown, contextUrl?: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (classifyGitError(message)) {
    const prefix = contextUrl ? `Upstream unavailable for ${contextUrl}: ` : 'Upstream unavailable: ';
    throw new UpstreamUnavailableError(prefix + message, { cause: err });
  }
  throw err instanceof Error ? err : new Error(message);
}
