import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/config/defaults';
import { setConfigStorage, type ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';
import { markDesktopWelcomeCompleted, shouldShowDesktopWelcome } from '../desktopWelcome';

function installStorage(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const storage: ConfigStorageProvider = {
    get: vi.fn(async (key: string) => store.get(key) ?? null) as ConfigStorageProvider['get'],
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }) as ConfigStorageProvider['set'],
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getMany: vi.fn(async (keys: string[]) => {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key);
      }
      return result;
    }) as ConfigStorageProvider['getMany'],
    setMany: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }) as ConfigStorageProvider['setMany'],
    removeMany: vi.fn(async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    }),
    getAll: vi.fn(async () => Object.fromEntries(store)),
    clear: vi.fn(async () => {
      store.clear();
    }),
    getBytesInUse: vi.fn(async () => null),
  };
  setConfigStorage(storage);
  return { store, storage };
}

describe('desktop first-run welcome', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the guide for a fresh desktop profile and seeds an incomplete marker', async () => {
    const { store } = installStorage();

    await expect(shouldShowDesktopWelcome()).resolves.toBe(true);
    expect(store.get(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED)).toBe(false);
  });

  it('does not show the guide for existing profiles without a marker', async () => {
    const { store } = installStorage({
      [STORAGE_KEYS.CONFIG]: { selectedModelKey: 'openai:gpt-4o' },
    });

    await expect(shouldShowDesktopWelcome()).resolves.toBe(false);
    expect(store.get(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED)).toBe(true);
  });

  it('keeps showing the guide until completion is recorded', async () => {
    installStorage({
      [STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED]: false,
    });

    await expect(shouldShowDesktopWelcome()).resolves.toBe(true);
  });

  it('records completion when the guide is skipped or finished', async () => {
    const { store } = installStorage({
      [STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED]: false,
    });

    await markDesktopWelcomeCompleted();
    expect(store.get(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED)).toBe(true);
    await expect(shouldShowDesktopWelcome()).resolves.toBe(false);
  });
});
