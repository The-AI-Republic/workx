import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExtensionInstanceId, DeferredReload } from '../extensionLifecycle';

describe('getExtensionInstanceId', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
      },
    };
  });

  it('generates and persists a UUID on first call', async () => {
    const id = await getExtensionInstanceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store['workx:extension_instance_id']).toBe(id);
  });

  it('returns the persisted UUID on subsequent calls', async () => {
    store['workx:extension_instance_id'] = 'existing';
    expect(await getExtensionInstanceId()).toBe('existing');
  });
});

describe('DeferredReload', () => {
  let updateListener: (() => void) | null;

  beforeEach(() => {
    updateListener = null;
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      runtime: {
        onUpdateAvailable: { addListener: (cb: () => void) => (updateListener = cb) },
      },
    };
  });

  it('defers reload while a session is active, then reloads when it ends', () => {
    let active = true;
    const reload = vi.fn();
    const dr = new DeferredReload(() => active, reload);
    dr.register();

    updateListener?.(); // update arrives mid-session
    expect(reload).not.toHaveBeenCalled();

    active = false;
    dr.onSessionEnded();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads immediately when idle at update time', () => {
    const reload = vi.fn();
    const dr = new DeferredReload(() => false, reload);
    dr.register();
    updateListener?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no update is pending', () => {
    const reload = vi.fn();
    const dr = new DeferredReload(() => false, reload);
    dr.register();
    dr.onSessionEnded();
    expect(reload).not.toHaveBeenCalled();
  });
});
