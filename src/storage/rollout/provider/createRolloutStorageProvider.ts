/**
 * Factory for creating the appropriate RolloutStorageProvider
 * based on the current build mode.
 *
 * - Extension: IndexedDBRolloutStorageProvider (IndexedDB "ApplePiRollouts")
 * - Desktop:   TauriRolloutStorageProvider (invoke → Rust/rusqlite → SQLite)
 * - Server:    TSRolloutStorageProvider (better-sqlite3 → SQLite)
 */

import type { RolloutStorageProvider } from './RolloutStorageProvider';

declare const __BUILD_MODE__: 'extension' | 'desktop' | 'server';

export async function createRolloutStorageProvider(): Promise<RolloutStorageProvider> {
  if (__BUILD_MODE__ === 'desktop') {
    const { TauriRolloutStorageProvider } = await import('./TauriRolloutStorageProvider');
    const provider = new TauriRolloutStorageProvider();
    await provider.initialize();
    return provider;
  }

  if (__BUILD_MODE__ === 'server') {
    const { getDataDir } = await import('@/server/config/server-config');
    const { TSRolloutStorageProvider } = await import('./TSRolloutStorageProvider');
    const provider = new TSRolloutStorageProvider(getDataDir());
    await provider.initialize();
    return provider;
  }

  if (__BUILD_MODE__ === 'extension') {
    const { IndexedDBRolloutStorageProvider } = await import('./IndexedDBRolloutStorageProvider');
    const provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
    return provider;
  }

  throw new Error(`Unsupported build mode: ${__BUILD_MODE__}`);
}
