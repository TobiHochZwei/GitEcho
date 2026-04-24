import { getPluginRegistry } from './interface.js';
import { GitHubPlugin } from './github.js';
import { AzureDevOpsPlugin } from './azuredevops.js';
import { GitLabPlugin } from './gitlab.js';

export function registerAllPlugins(): void {
  const registry = getPluginRegistry();
  registry.register(new GitHubPlugin());
  registry.register(new AzureDevOpsPlugin());
  registry.register(new GitLabPlugin());
}
