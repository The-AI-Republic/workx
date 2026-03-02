/**
 * Factory for creating the appropriate RolloutStorageProvider
 * based on the current build mode.
 *
 * - Extension: IndexedDBRolloutStorageProvider (IndexedDB "PiRollouts")
 * - Desktop:   TauriRolloutStorageProvider (invoke → Rust/rusqlite → SQLite)
 */

import type { RolloutStorageProvider } from './RolloutStorageProvider';

declare const __BUILD_MODE__: 'extension' | 'desktop';

export async function createRolloutStorageProvider(): Promise<RolloutStorageProvider> {
  if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop') {
    const { TauriRolloutStorageProvider } = await import('./TauriRolloutStorageProvider');
    const provider = new TauriRolloutStorageProvider();
    await provider.initialize();
    return provider;
  } else {
    // Default to IndexedDB (extension mode)
    const { IndexedDBRolloutStorageProvider } = await import('./IndexedDBRolloutStorageProvider');
    const provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
    return provider;
  }
}
