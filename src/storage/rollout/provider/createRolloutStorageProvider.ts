/**
 * Factory for creating the appropriate RolloutStorageProvider
 * based on the current build mode.
 *
 * - Extension: IndexedDBRolloutStorageProvider (IndexedDB "WorkXRollouts")
 * - Desktop:   Runtime sidecar only; WebView rollout storage is disabled
 * - Server:    TSRolloutStorageProvider (better-sqlite3 → SQLite)
 */

import type { RolloutStorageProvider } from './RolloutStorageProvider';
import { isDesktopRuntimeProfile } from '@/runtime/profile';

declare const __BUILD_MODE__: 'extension' | 'desktop' | 'server';

export async function createRolloutStorageProvider(): Promise<RolloutStorageProvider> {
  if (__BUILD_MODE__ === 'desktop') {
    throw new Error('Desktop WebView rollout storage is owned by the runtime sidecar.');
  }

  if (__BUILD_MODE__ === 'server') {
    if (isDesktopRuntimeProfile()) {
      const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
      const { DesktopRuntimeRolloutStorageProvider } = await import(
        '@/desktop-runtime/storage/DesktopRuntimeRolloutStorageProvider'
      );
      const provider = new DesktopRuntimeRolloutStorageProvider(getDesktopRuntimeHost().rolloutDbPath);
      await provider.initialize();
      return provider;
    }
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
