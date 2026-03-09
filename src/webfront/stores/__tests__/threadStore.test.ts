/**
 * Unit tests for threadStore — multi-thread tab management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// Mock ConfigStorageProvider before importing threadStore
const mockConfigStorage = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => mockConfigStorage),
}));

import { threadStore, activeThread, threadCount } from '@/webfront/stores/threadStore';
import type { ThreadStoreState } from '@/webfront/stores/threadStore';
import { isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

describe('threadStore', () => {
  beforeEach(() => {
    threadStore.clear();
    vi.clearAllMocks();
    // Re-setup mocks after clearAllMocks (because of mockReset: true in vitest config)
    vi.mocked(isConfigStorageInitialized).mockReturnValue(true);
    mockConfigStorage.get.mockResolvedValue(null);
    mockConfigStorage.set.mockResolvedValue(undefined);
  });

  // =========================================================================
  // createThread
  // =========================================================================

  describe('createThread', () => {
    it('creates a thread with the given sessionId', () => {
      const thread = threadStore.createThread('session_abc');

      expect(thread.sessionId).toBe('session_abc');
      expect(thread.id).toBeTruthy();
      expect(thread.title).toBe('New Thread');
      expect(thread.createdAt).toBeGreaterThan(0);
    });

    it('auto-activates the newly created thread', () => {
      const thread = threadStore.createThread('session_abc');
      const state = get(threadStore);

      expect(state.activeThreadId).toBe(thread.id);
    });

    it('assigns unique IDs to each thread', () => {
      const thread1 = threadStore.createThread('session_1');
      const thread2 = threadStore.createThread('session_2');

      expect(thread1.id).not.toBe(thread2.id);
    });

    it('uses a custom title when provided', () => {
      const thread = threadStore.createThread('session_x', 'My Custom Thread');

      expect(thread.title).toBe('My Custom Thread');
    });

    it('persists to config storage', () => {
      threadStore.createThread('session_1');

      expect(mockConfigStorage.set).toHaveBeenCalled();
    });

    it('adds thread to the threads array', () => {
      threadStore.createThread('s1');
      threadStore.createThread('s2');
      const state = get(threadStore);

      expect(state.threads).toHaveLength(2);
    });

    it('activates the last created thread when multiple are created', () => {
      threadStore.createThread('s1');
      const thread2 = threadStore.createThread('s2');
      const state = get(threadStore);

      expect(state.activeThreadId).toBe(thread2.id);
    });
  });

  // =========================================================================
  // closeThread
  // =========================================================================

  describe('closeThread', () => {
    it('removes the specified thread', () => {
      const thread = threadStore.createThread('s1');
      threadStore.createThread('s2');
      threadStore.closeThread(thread.id);

      const state = get(threadStore);
      expect(state.threads.find((t) => t.id === thread.id)).toBeUndefined();
    });

    it('selects an adjacent thread when closing the active thread', () => {
      const thread1 = threadStore.createThread('s1');
      const thread2 = threadStore.createThread('s2');
      threadStore.createThread('s3');

      // thread3 is active (last created). Switch to thread2, then close it.
      threadStore.setActiveThread(thread2.id);
      threadStore.closeThread(thread2.id);

      const state = get(threadStore);
      // Should pick the thread at the same index or previous
      expect(state.activeThreadId).not.toBe(thread2.id);
      expect(state.threads.some((t) => t.id === state.activeThreadId)).toBe(true);
    });

    it('sets activeThreadId to null when closing the last thread', () => {
      const thread = threadStore.createThread('s1');
      threadStore.closeThread(thread.id);

      const state = get(threadStore);
      expect(state.activeThreadId).toBeNull();
      expect(state.threads).toHaveLength(0);
    });

    it('is a no-op for an unknown thread ID', () => {
      threadStore.createThread('s1');
      const stateBefore = get(threadStore);

      threadStore.closeThread('nonexistent');

      const stateAfter = get(threadStore);
      expect(stateAfter.threads).toEqual(stateBefore.threads);
    });

    it('selects the first thread when closing the first thread', () => {
      const thread1 = threadStore.createThread('s1');
      const thread2 = threadStore.createThread('s2');
      // Activate and close the first thread
      threadStore.setActiveThread(thread1.id);
      threadStore.closeThread(thread1.id);

      const state = get(threadStore);
      expect(state.activeThreadId).toBe(thread2.id);
    });

    it('persists after closing', () => {
      const thread = threadStore.createThread('s1');
      vi.mocked(mockConfigStorage.set).mockClear();

      threadStore.closeThread(thread.id);
      expect(mockConfigStorage.set).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // setActiveThread
  // =========================================================================

  describe('setActiveThread', () => {
    it('sets the active thread ID', () => {
      const thread1 = threadStore.createThread('s1');
      threadStore.createThread('s2');

      threadStore.setActiveThread(thread1.id);
      const state = get(threadStore);

      expect(state.activeThreadId).toBe(thread1.id);
    });

    it('is a no-op for a nonexistent thread ID', () => {
      threadStore.createThread('s1');
      const stateBefore = get(threadStore);

      threadStore.setActiveThread('nonexistent');
      const stateAfter = get(threadStore);

      expect(stateAfter.activeThreadId).toBe(stateBefore.activeThreadId);
    });
  });

  // =========================================================================
  // updateThreadTitle
  // =========================================================================

  describe('updateThreadTitle', () => {
    it('updates the title of the specified thread', () => {
      const thread = threadStore.createThread('s1');
      threadStore.updateThreadTitle(thread.id, 'Renamed Thread');

      const state = get(threadStore);
      expect(state.threads.find((t) => t.id === thread.id)?.title).toBe('Renamed Thread');
    });

    it('does not affect other threads', () => {
      const thread1 = threadStore.createThread('s1', 'Thread A');
      const thread2 = threadStore.createThread('s2', 'Thread B');

      threadStore.updateThreadTitle(thread1.id, 'Updated A');

      const state = get(threadStore);
      expect(state.threads.find((t) => t.id === thread2.id)?.title).toBe('Thread B');
    });
  });

  // =========================================================================
  // getThreadBySessionId
  // =========================================================================

  describe('getThreadBySessionId', () => {
    it('returns the thread matching the sessionId', () => {
      const thread = threadStore.createThread('session_123');
      const found = threadStore.getThreadBySessionId('session_123');

      expect(found?.id).toBe(thread.id);
    });

    it('returns undefined for an unknown sessionId', () => {
      threadStore.createThread('session_abc');
      const found = threadStore.getThreadBySessionId('unknown');

      expect(found).toBeUndefined();
    });
  });

  // =========================================================================
  // getActiveThread
  // =========================================================================

  describe('getActiveThread', () => {
    it('returns the active thread', () => {
      const thread = threadStore.createThread('s1');
      const active = threadStore.getActiveThread();

      expect(active?.id).toBe(thread.id);
    });

    it('returns undefined when no threads exist', () => {
      expect(threadStore.getActiveThread()).toBeUndefined();
    });

    it('returns undefined after clearing all threads', () => {
      threadStore.createThread('s1');
      threadStore.clear();

      expect(threadStore.getActiveThread()).toBeUndefined();
    });
  });

  // =========================================================================
  // removeThreadBySessionId
  // =========================================================================

  describe('removeThreadBySessionId', () => {
    it('finds and removes the thread by sessionId', () => {
      threadStore.createThread('session_to_remove');
      threadStore.createThread('session_to_keep');

      threadStore.removeThreadBySessionId('session_to_remove');

      const state = get(threadStore);
      expect(state.threads).toHaveLength(1);
      expect(state.threads[0].sessionId).toBe('session_to_keep');
    });

    it('is a no-op for an unknown sessionId', () => {
      threadStore.createThread('s1');
      const before = get(threadStore);

      threadStore.removeThreadBySessionId('nonexistent');

      const after = get(threadStore);
      expect(after.threads).toHaveLength(before.threads.length);
    });
  });

  // =========================================================================
  // restoreThreads
  // =========================================================================

  describe('restoreThreads', () => {
    it('restores threads from config storage', async () => {
      const stored: ThreadStoreState = {
        threads: [
          { id: 't1', sessionId: 's1', title: 'Restored', createdAt: 1000 },
        ],
        activeThreadId: 't1',
      };
      mockConfigStorage.get.mockResolvedValue(stored);

      const result = await threadStore.restoreThreads();

      expect(result.threads).toHaveLength(1);
      expect(result.threads[0].title).toBe('Restored');
      const state = get(threadStore);
      expect(state.threads).toHaveLength(1);
    });

    it('returns initial state when storage is empty', async () => {
      mockConfigStorage.get.mockResolvedValue(null);

      const result = await threadStore.restoreThreads();

      expect(result.threads).toHaveLength(0);
      expect(result.activeThreadId).toBeNull();
    });

    it('returns initial state when storage has empty threads array', async () => {
      mockConfigStorage.get.mockResolvedValue({ threads: [], activeThreadId: null });

      const result = await threadStore.restoreThreads();

      expect(result.threads).toHaveLength(0);
    });

    it('handles storage errors gracefully', async () => {
      mockConfigStorage.get.mockRejectedValue(new Error('Storage failure'));

      const result = await threadStore.restoreThreads();

      expect(result.threads).toHaveLength(0);
    });

    it('skips restore when ConfigStorage is not initialized', async () => {
      vi.mocked(isConfigStorageInitialized).mockReturnValue(false);

      const result = await threadStore.restoreThreads();

      expect(result.threads).toHaveLength(0);
      expect(mockConfigStorage.get).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // clear / setState
  // =========================================================================

  describe('clear', () => {
    it('resets all threads and activeThreadId', () => {
      threadStore.createThread('s1');
      threadStore.createThread('s2');
      threadStore.clear();

      const state = get(threadStore);
      expect(state.threads).toHaveLength(0);
      expect(state.activeThreadId).toBeNull();
    });
  });

  describe('setState', () => {
    it('replaces the full state', () => {
      threadStore.createThread('original');

      const newState: ThreadStoreState = {
        threads: [
          { id: 'x1', sessionId: 'sx1', title: 'Set', createdAt: 500 },
          { id: 'x2', sessionId: 'sx2', title: 'State', createdAt: 600 },
        ],
        activeThreadId: 'x2',
      };

      threadStore.setState(newState);

      const state = get(threadStore);
      expect(state.threads).toHaveLength(2);
      expect(state.activeThreadId).toBe('x2');
    });

    it('persists the new state', () => {
      vi.mocked(mockConfigStorage.set).mockClear();
      threadStore.setState({ threads: [], activeThreadId: null });

      expect(mockConfigStorage.set).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Derived stores
  // =========================================================================

  describe('activeThread derived store', () => {
    it('reflects the currently active thread', () => {
      const thread = threadStore.createThread('s1');
      const active = get(activeThread);

      expect(active?.id).toBe(thread.id);
    });

    it('is undefined when no threads exist', () => {
      expect(get(activeThread)).toBeUndefined();
    });
  });

  describe('threadCount derived store', () => {
    it('reflects the number of threads', () => {
      expect(get(threadCount)).toBe(0);

      threadStore.createThread('s1');
      expect(get(threadCount)).toBe(1);

      threadStore.createThread('s2');
      expect(get(threadCount)).toBe(2);
    });

    it('decrements when a thread is closed', () => {
      const thread = threadStore.createThread('s1');
      threadStore.createThread('s2');

      threadStore.closeThread(thread.id);
      expect(get(threadCount)).toBe(1);
    });
  });
});
