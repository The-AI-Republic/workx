import path from 'node:path';
import { ComponentError } from '@/core/components';
import { resolveWorkXHome } from '@/runtime/workxHome';

export interface WorkXPaths {
  root: string;
  components: string;
  downloads: string;
  workspaces: string;
  logs: string;
}

export interface WorkXPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveWorkXPaths(options: WorkXPathOptions = {}): WorkXPaths {
  let resolvedRoot: string;
  try {
    resolvedRoot = resolveWorkXHome(options);
  } catch (error) {
    throw new ComponentError('COMPONENT_PATH_INVALID', (error as Error).message, false, {
      cause: error,
    });
  }
  return {
    root: resolvedRoot,
    components: path.join(resolvedRoot, 'components'),
    downloads: path.join(resolvedRoot, 'downloads'),
    workspaces: path.join(resolvedRoot, 'workspaces'),
    logs: path.join(resolvedRoot, 'logs'),
  };
}
