/**
 * Storage Adapter Factory
 *
 * 3-way routing based on __BUILD_MODE__:
 * - extension → IndexedDBAdapter (existing behavior)
 * - desktop → TauriSQLiteAdapter (routes through Tauri invoke to Rust SQLite)
 * - server → NodeSQLiteAdapter (uses better-sqlite3 directly)
 *
 * @module storage/createStorageAdapter
 */

import type { StorageAdapter } from './StorageAdapter';

/**
 * Create the appropriate StorageAdapter for the current build mode.
 *
 * @returns Initialized StorageAdapter instance
 */
export async function createStorageAdapter(): Promise<StorageAdapter> {
  if (__BUILD_MODE__ === 'extension') {
    const { IndexedDBAdapter } = await import('./IndexedDBAdapter');
    return new IndexedDBAdapter();
  }
  if (__BUILD_MODE__ === 'desktop') {
    const { TauriSQLiteAdapter } = await import(
      '@/desktop/storage/TauriSQLiteAdapter'
    );
    return new TauriSQLiteAdapter();
  }
  if (__BUILD_MODE__ === 'server') {
    const { getDataDir } = await import('@/server/config/server-config');
    const { NodeSQLiteAdapter } = await import(
      '@/server/storage/NodeSQLiteAdapter'
    );
    return new NodeSQLiteAdapter(getDataDir());
  }
  throw new Error(`Unsupported build mode for StorageAdapter: ${__BUILD_MODE__}`);
}
