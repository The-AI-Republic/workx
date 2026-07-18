import os from 'node:os';
import path from 'node:path';

export interface WorkXHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Shared per-user root for plugins, components, styles, and runtime workspaces. */
export function resolveWorkXHome(options: WorkXHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.WORKX_HOME?.trim();
  const root = configured || path.join(options.homeDir ?? os.homedir(), '.workx');
  if (!path.isAbsolute(root)) {
    throw new Error('WORKX_HOME must be an absolute filesystem path.');
  }
  return path.resolve(root);
}
