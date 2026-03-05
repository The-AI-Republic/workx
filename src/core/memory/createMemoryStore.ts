import type { MemoryStore } from './MemoryStore';

declare const __BUILD_MODE__: 'desktop' | 'server' | 'extension';

/**
 * Factory for creating platform-specific MemoryStore instances.
 * Follows the same pattern as createStorageAdapter.ts.
 */
export async function createMemoryStore(): Promise<MemoryStore> {
  if (__BUILD_MODE__ === 'desktop') {
    const { TauriMemoryStore } = await import(
      '@/desktop/storage/TauriMemoryStore'
    );
    return new TauriMemoryStore();
  }
  if (__BUILD_MODE__ === 'server') {
    const { NodeMemoryStore } = await import(
      '@/server/storage/NodeMemoryStore'
    );
    return new NodeMemoryStore();
  }
  throw new Error(
    `Memory system not supported in build mode: ${__BUILD_MODE__}`
  );
}
