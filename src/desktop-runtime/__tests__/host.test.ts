import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDesktopRuntimeHost,
  createDevDesktopRuntimeHost,
  setDesktopRuntimeHost,
} from '../host';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('desktop runtime host', () => {
  it('requires Rust-provided desktop paths by default', async () => {
    delete process.env.WORKX_DESKTOP_RUNTIME_ALLOW_DEV_HOST;
    delete process.env.WORKX_DESKTOP_CONFIG_DIR;

    await expect(createDevDesktopRuntimeHost()).rejects.toThrow('WORKX_DESKTOP_RUNTIME_HOST is required');
  });

  it('allows the dev fallback only through an explicit local-development override', async () => {
    process.env.WORKX_DESKTOP_RUNTIME_ALLOW_DEV_HOST = 'true';
    process.env.WORKX_DESKTOP_CONFIG_DIR = '/tmp/apple-pi-dev-test';

    const host = await createDevDesktopRuntimeHost();

    expect(host.configDir).toBe('/tmp/apple-pi-dev-test');
    expect(host.storageDbPath).toBe('/tmp/apple-pi-dev-test/storage.db');
    expect(host.rolloutDbPath).toBe('/tmp/apple-pi-dev-test/rollouts.db');
    expect(host.configJsonPath).toBe('/tmp/apple-pi-dev-test/config.json');
  });

  it('rejects incomplete host path handshakes', () => {
    expect(() => assertDesktopRuntimeHost({
      configDir: '/config',
      storageDbPath: '',
      rolloutDbPath: '/config/rollouts.db',
      configJsonPath: '/config/config.json',
    })).toThrow('storageDbPath');
  });

  it('validates hosts passed into the global runtime host setter', () => {
    expect(() => setDesktopRuntimeHost({
      configDir: '/config',
      storageDbPath: '/config/storage.db',
      rolloutDbPath: '/config/rollouts.db',
      configJsonPath: '/config/config.json',
    })).not.toThrow();
  });
});
