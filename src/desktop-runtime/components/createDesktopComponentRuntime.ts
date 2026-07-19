import type { ComponentManager } from '@/core/components';
import { ComponentRunner } from './ComponentRunner';
import { NodeComponentManager } from './NodeComponentManager';
import { WorkXWorkspaceManager } from './WorkXWorkspaceManager';
import { componentPlatform, createBuiltinComponentCatalog } from './builtinCatalog';
import { resolveWorkXPaths, type WorkXPaths } from './workxPaths';

export interface DesktopComponentRuntime {
  paths: WorkXPaths;
  manager: ComponentManager;
  runner: ComponentRunner;
  workspaces: WorkXWorkspaceManager;
  dispose(): Promise<void>;
}

export interface CreateDesktopComponentRuntimeOptions {
  paths?: WorkXPaths;
  platform?: ReturnType<typeof componentPlatform>;
  fetchImpl?: typeof fetch;
}

export async function createDesktopComponentRuntime(
  options: CreateDesktopComponentRuntimeOptions = {}
): Promise<DesktopComponentRuntime> {
  const paths = options.paths ?? resolveWorkXPaths();
  const manager = new NodeComponentManager({
    paths,
    platform: options.platform === undefined ? componentPlatform() : options.platform,
    catalog: createBuiltinComponentCatalog(),
    fetchImpl: options.fetchImpl,
  });
  const workspaces = new WorkXWorkspaceManager(paths);
  await manager.initialize();
  await workspaces.initialize();
  const runner = new ComponentRunner(manager);
  return {
    paths,
    manager,
    runner,
    workspaces,
    dispose: async () => {
      await runner.dispose();
      await manager.dispose();
      await workspaces.dispose();
    },
  };
}
