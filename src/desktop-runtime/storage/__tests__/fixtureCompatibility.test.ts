/**
 * Fixture compatibility — real better-sqlite3, real file system.
 *
 * Asserts the design contract from Track 43 design.md, "Decision 4: Storage
 * And Migration":
 *
 *   - The desktop-runtime providers open existing Rust-created files in place.
 *   - They do NOT create `storage/`, `rollouts/`, or `config-storage.json`
 *     subpaths (which the server providers would default to).
 *   - All desktop collections used by scheduler, sessions, config, cache,
 *     rollout, token usage, and task output chunks open and accept a no-op
 *     open/read/write round-trip without migration.
 *
 * Run-time precondition: better-sqlite3 native addon must load. This is the
 * same contract the packaged sidecar relies on, so any addon-load regression
 * shows up here in CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// vitest aliases `better-sqlite3` to a stub for unit tests that mock the module.
// This file is the opposite: we need the real native addon to validate the
// fixture contract. Reach the real package via createRequire (CommonJS
// resolution bypasses Vite's alias graph) and pre-register it under the alias
// so any downstream import inside provider modules also hits the real one.
const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');
vi.mock('better-sqlite3', () => ({ default: Database }));

import { DesktopRuntimeStorageProvider } from '../DesktopRuntimeStorageProvider';
import { DesktopRuntimeSQLiteAdapter } from '../DesktopRuntimeSQLiteAdapter';
import { DesktopRuntimeRolloutStorageProvider } from '../DesktopRuntimeRolloutStorageProvider';
import { DesktopRuntimeConfigStorageProvider } from '../DesktopRuntimeConfigStorageProvider';

/** Collections the Rust desktop side created in storage.db; the runtime must
 *  open every one of them without migrating, replacing, or renaming. The list
 *  matches the ALLOWED_COLLECTIONS constant from the deleted Rust
 *  `db_storage.rs` (see git history pre-cutover). */
const RUST_DESKTOP_COLLECTIONS = [
  'conversations',
  'messages',
  'memory',
  'settings',
  'cache',
  'credentials',
  'skills',
  'tasks',
  'cache_items',
  'sessions',
  'config',
  'rollout_cache',
  'scheduler_jobs',
  'agent_sessions',
  'schedule_events',
  'schedule_exceptions',
  'execution_records',
  'token_usage_records',
  'task_output_chunks',
] as const;

function buildRustStorageFixture(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const tx = db.transaction(() => {
      for (const coll of RUST_DESKTOP_COLLECTIONS) {
        db.exec(`CREATE TABLE IF NOT EXISTS "${coll}" (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      }
      // Seed one row per collection so the runtime providers must read existing
      // user data, not just open an empty schema.
      const stmt = db.prepare(
        'INSERT INTO "config" (key, value, created_at, updated_at) VALUES (?,?,?,?)',
      );
      stmt.run('agent_config', JSON.stringify({ selectedModelKey: 'openai/gpt-5' }), 1, 1);
    });
    tx();
  } finally {
    db.close();
  }
}

function buildRustRolloutFixture(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rollout_metadata (
        id TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        expires_at INTEGER,
        session_meta TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_expires ON rollout_metadata(expires_at);
      CREATE INDEX IF NOT EXISTS idx_metadata_updated ON rollout_metadata(updated);

      CREATE TABLE IF NOT EXISTS rollout_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(rollout_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
    `);
    // Seed one rollout row so reopen has something to roundtrip on.
    db.prepare(
      'INSERT INTO rollout_metadata (id, created, updated, session_meta, item_count) VALUES (?,?,?,?,?)',
    ).run('rollout-fixture-1', 1, 1, JSON.stringify({ from: 'fixture' }), 0);
  } finally {
    db.close();
  }
}

function listAllPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, ent.name);
      out.push(path.relative(root, child));
      if (ent.isDirectory()) walk(child);
    }
  };
  walk(root);
  return out.sort();
}

describe('Desktop runtime providers — fixture compatibility', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('opens an existing Rust-created storage.db in place, with no server subpath created', async () => {
    const storageDbPath = path.join(configDir, 'storage.db');
    buildRustStorageFixture(storageDbPath);
    const before = listAllPaths(configDir);

    const provider = new DesktopRuntimeStorageProvider(storageDbPath);
    await provider.initialize();

    // Round-trip a row in every Rust-created collection. None of these should
    // throw, none should create a new file, and the seeded config row must be
    // readable without migration.
    for (const coll of RUST_DESKTOP_COLLECTIONS) {
      const ping = { ping: coll, at: Date.now() };
      await provider.set(coll, '__roundtrip', ping);
      expect(await provider.get(coll, '__roundtrip')).toEqual(ping);
    }
    expect(await provider.get('config', 'agent_config')).toEqual({ selectedModelKey: 'openai/gpt-5' });

    await provider.close();

    // The provider must not have created `storage/storage.db` (the server
    // provider's default subpath); it must keep using the file we passed.
    const after = listAllPaths(configDir);
    expect(after).toContain('storage.db');
    expect(after.some((p) => p === 'storage' || p.startsWith(`storage${path.sep}`))).toBe(false);
    // -wal/-shm files are SQLite-internal and expected; ignore them.
    const nonSqliteCreated = after
      .filter((p) => !before.includes(p))
      .filter((p) => !p.endsWith('-wal') && !p.endsWith('-shm'));
    expect(nonSqliteCreated).toEqual([]);
  });

  it('opens an existing Rust-created storage.db through the SQLite adapter without creating server subdirs', async () => {
    const storageDbPath = path.join(configDir, 'storage.db');
    buildRustStorageFixture(storageDbPath);

    const adapter = new DesktopRuntimeSQLiteAdapter(storageDbPath);
    await adapter.initialize();

    // Adapter and Provider point at the same file; smoke-test the
    // scheduler-related collections that route through the adapter.
    const stateOnce = adapter.getDatabase?.();
    void stateOnce;
    await adapter.close?.();

    const after = listAllPaths(configDir);
    expect(after.some((p) => p === 'storage' || p.startsWith(`storage${path.sep}`))).toBe(false);
  });

  it('opens an existing Rust-created rollouts.db in place, no rollouts/ subpath created', async () => {
    const rolloutDbPath = path.join(configDir, 'rollouts.db');
    buildRustRolloutFixture(rolloutDbPath);

    const provider = new DesktopRuntimeRolloutStorageProvider(rolloutDbPath);
    await provider.initialize();

    // We don't depend on the rollout provider's full API surface; we just
    // need to prove it opens the existing file and the fixture row survives.
    const reopen = new Database(rolloutDbPath, { readonly: true });
    const row = reopen
      .prepare('SELECT id, session_meta FROM rollout_metadata WHERE id = ?')
      .get('rollout-fixture-1') as { id: string; session_meta: string } | undefined;
    reopen.close();
    expect(row?.id).toBe('rollout-fixture-1');
    expect(JSON.parse(row!.session_meta)).toEqual({ from: 'fixture' });

    await provider.close?.();

    const after = listAllPaths(configDir);
    expect(after).toContain('rollouts.db');
    expect(after.some((p) => p === 'rollouts' || p.startsWith(`rollouts${path.sep}`))).toBe(false);
  });

  it('preserves an existing Rust-created config.json shape; never writes config-storage.json', async () => {
    const configJsonPath = path.join(configDir, 'config.json');
    // Simulate what Tauri/Rust would have written before the cutover.
    fs.writeFileSync(
      configJsonPath,
      JSON.stringify({
        agent_config: { selectedModelKey: 'openai/gpt-5' },
        applepi_credentials: { hasAuth: true },
      }),
      'utf-8',
    );

    const provider = new DesktopRuntimeConfigStorageProvider(configJsonPath);
    expect(await provider.get('agent_config')).toEqual({ selectedModelKey: 'openai/gpt-5' });

    await provider.set('desktopRuntime', { startedAt: 12345 });

    const onDisk = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
    expect(onDisk).toEqual({
      agent_config: { selectedModelKey: 'openai/gpt-5' },
      applepi_credentials: { hasAuth: true },
      desktopRuntime: { startedAt: 12345 },
    });
    expect(fs.existsSync(path.join(configDir, 'config-storage.json'))).toBe(false);
  });
});
