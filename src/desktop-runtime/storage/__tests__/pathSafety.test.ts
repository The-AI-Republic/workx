import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const openedDbPaths: string[] = [];
const mockPrepare = vi.fn(() => ({
  get: vi.fn(),
  all: vi.fn(() => []),
  run: vi.fn(() => ({ changes: 1 })),
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn((dbPath: string) => {
    openedDbPaths.push(dbPath);
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: mockPrepare,
      close: vi.fn(),
      transaction: vi.fn((fn: Function) => (...args: unknown[]) => fn(...args)),
    };
  }),
}));

import { DesktopRuntimeConfigStorageProvider } from '../DesktopRuntimeConfigStorageProvider';
import { DesktopRuntimeRolloutStorageProvider } from '../DesktopRuntimeRolloutStorageProvider';
import { DesktopRuntimeSQLiteAdapter } from '../DesktopRuntimeSQLiteAdapter';
import { DesktopRuntimeStorageProvider } from '../DesktopRuntimeStorageProvider';

describe('desktop runtime path-compatible storage providers', () => {
  let configDir: string;

  beforeEach(() => {
    openedDbPaths.length = 0;
    vi.clearAllMocks();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-paths-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('opens existing desktop database paths in place without creating server subdirectories', async () => {
    const storageDbPath = path.join(configDir, 'storage.db');
    const rolloutDbPath = path.join(configDir, 'rollouts.db');

    const storageProvider = new DesktopRuntimeStorageProvider(storageDbPath);
    const sqliteAdapter = new DesktopRuntimeSQLiteAdapter(storageDbPath);
    const rolloutProvider = new DesktopRuntimeRolloutStorageProvider(rolloutDbPath);

    await storageProvider.initialize();
    await sqliteAdapter.initialize();
    await rolloutProvider.initialize();

    expect(openedDbPaths).toEqual([storageDbPath, storageDbPath, rolloutDbPath]);
    expect(fs.existsSync(path.join(configDir, 'storage'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'rollouts'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'config-storage.json'))).toBe(false);
  });

  it('preserves desktop config.json semantics and never writes config-storage.json', async () => {
    const configJsonPath = path.join(configDir, 'config.json');
    fs.writeFileSync(configJsonPath, JSON.stringify({ agent_config: { selectedModelKey: 'openai/gpt-5' } }));

    const provider = new DesktopRuntimeConfigStorageProvider(configJsonPath);
    expect(await provider.get('agent_config')).toEqual({ selectedModelKey: 'openai/gpt-5' });

    await provider.set('desktopRuntime', { enabled: true });

    expect(JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'))).toEqual({
      agent_config: { selectedModelKey: 'openai/gpt-5' },
      desktopRuntime: { enabled: true },
    });
    expect(fs.existsSync(path.join(configDir, 'config-storage.json'))).toBe(false);
  });
});
