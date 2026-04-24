export interface RepositoryInfo {
  url: string;
  name: string;
  owner: string;
  provider: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  description?: string;
}

/**
 * Per-repository debug-trace context passed into clone/pull calls.
 *
 * Populated by the backup engine from the `repositories` DB row, so plugins
 * no longer have to reverse-lookup the flag via the repo URL — which was
 * fragile when stored URLs and canonicalised URLs disagreed (e.g. legacy
 * `*.visualstudio.com/DefaultCollection/…` vs. `dev.azure.com/…`).
 *
 * Optional so direct/test callers that do not have a DB row can still use
 * the plugin methods; tracing is simply disabled in that case.
 */
export interface TraceContext {
  enabled: boolean;
  repoId: number;
}

export interface PluginCallOptions {
  trace?: TraceContext;
}

export interface ProviderPlugin {
  /** Unique provider identifier */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /** Check if the provider is configured (has PAT, etc.) */
  isConfigured(): boolean;

  /** Verify authentication works */
  authenticate(): Promise<boolean>;

  /** List all accessible repositories */
  listRepositories(): Promise<RepositoryInfo[]>;

  /** Clone a repository to the target directory */
  cloneRepository(
    repoUrl: string,
    targetDir: string,
    opts?: PluginCallOptions,
  ): Promise<void>;

  /** Pull latest changes for an already-cloned repository */
  pullRepository(repoDir: string, opts?: PluginCallOptions): Promise<void>;

  /** Get the authenticated clone URL (with PAT embedded if needed) */
  getAuthenticatedUrl(repoUrl: string): string;
}

export class PluginRegistry {
  private plugins: Map<string, ProviderPlugin> = new Map();

  register(plugin: ProviderPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): ProviderPlugin | undefined {
    return this.plugins.get(name);
  }

  getAll(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }

  getConfigured(): ProviderPlugin[] {
    return this.getAll().filter((p) => p.isConfigured());
  }
}

// Singleton registry
let registry: PluginRegistry | undefined;

export function getPluginRegistry(): PluginRegistry {
  if (!registry) {
    registry = new PluginRegistry();
  }
  return registry;
}
