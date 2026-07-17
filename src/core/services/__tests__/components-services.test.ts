import { describe, expect, it, vi } from 'vitest';
import { ComponentRuntimeHandle, type ComponentManager } from '@/core/components';
import { createComponentServices } from '../components-services';

const desktopContext = {
  channelId: 'desktop-runtime-main',
  channelType: 'tauri' as const,
};

function manager(): ComponentManager {
  return {
    initialize: vi.fn(),
    status: vi.fn(() => ({ state: 'ready', available: true })),
    list: vi.fn(async () => []),
    get: vi.fn(),
    install: vi.fn(async (id) => ({ id, state: 'installed' })),
    verify: vi.fn(async (id) => ({ id, state: 'installed' })),
    uninstall: vi.fn(async () => undefined),
    resolveEntrypoint: vi.fn(),
    acquireEntrypoint: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ComponentManager;
}

describe('component services', () => {
  it('routes management operations through the shared manager', async () => {
    const runtime = manager();
    const handle = new ComponentRuntimeHandle();
    handle.setReady(runtime);
    const services = createComponentServices({ handle });

    await services['components.list']({}, desktopContext);
    await services['components.install']({ componentId: 'duckdb' }, desktopContext);
    await services['components.verify']({ componentId: 'duckdb' }, desktopContext);
    await services['components.uninstall']({ componentId: 'duckdb' }, desktopContext);

    expect(runtime.list).toHaveBeenCalled();
    expect(runtime.install).toHaveBeenCalledWith('duckdb');
    expect(runtime.verify).toHaveBeenCalledWith('duckdb');
    expect(runtime.uninstall).toHaveBeenCalledWith('duckdb');
  });

  it('rejects remote service callers and unavailable runtimes', async () => {
    const handle = new ComponentRuntimeHandle();
    const services = createComponentServices({ handle });
    await expect(
      services['components.status']({}, { channelId: 'remote', channelType: 'websocket' })
    ).rejects.toMatchObject({ code: 'COMPONENT_ACCESS_DENIED' });
    await expect(services['components.list']({}, desktopContext)).rejects.toMatchObject({
      code: 'COMPONENTS_UNAVAILABLE',
    });
  });
});
