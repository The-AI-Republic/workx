/**
 * Thread Store for Side Panel Multi-Thread Support
 *
 * Manages sidepanel thread UI state using Svelte store.
 * Each thread corresponds to an AgentRegistry session.
 * Persists thread state via ConfigStorageProvider.
 */

import { writable, derived, get, type Writable } from 'svelte/store';
import { getConfigStorage, isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

/**
 * Sidepanel thread representation
 */
export interface SidePanelThread {
  /** Unique thread ID (uuid) */
  id: string;
  /** AgentRegistry session ID */
  sessionId: string;
  /** Display title */
  title: string;
  /** Creation timestamp for ordering */
  createdAt: number;
}

/**
 * Thread store state
 */
export interface ThreadStoreState {
  threads: SidePanelThread[];
  activeThreadId: string | null;
}

/**
 * Persistence key for config storage
 */
const STORAGE_KEY = 'browserx_sidepanel_threads';

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create the thread store
 */
function createThreadStore() {
  const initialState: ThreadStoreState = {
    threads: [],
    activeThreadId: null,
  };

  const { subscribe, set, update }: Writable<ThreadStoreState> = writable(initialState);

  return {
    subscribe,

    /**
     * Create a new thread for a session
     * @param sessionId The AgentRegistry session ID
     * @param title Optional initial title (defaults to "New Thread")
     * @returns The created thread
     */
    createThread: (sessionId: string, title: string = 'New Thread'): SidePanelThread => {
      const newThread: SidePanelThread = {
        id: generateUUID(),
        sessionId,
        title,
        createdAt: Date.now(),
      };

      update((state) => ({
        threads: [...state.threads, newThread],
        activeThreadId: newThread.id,
      }));

      persistThreads();

      return newThread;
    },

    /**
     * Close a thread by ID
     * @param threadId The thread ID to close
     */
    closeThread: (threadId: string): void => {
      update((state) => {
        const threadIndex = state.threads.findIndex((t) => t.id === threadId);
        if (threadIndex === -1) return state;

        const newThreads = state.threads.filter((t) => t.id !== threadId);

        let newActiveId = state.activeThreadId;
        if (state.activeThreadId === threadId && newThreads.length > 0) {
          const newIndex = Math.min(threadIndex, newThreads.length - 1);
          newActiveId = newThreads[newIndex]?.id || null;
        } else if (newThreads.length === 0) {
          newActiveId = null;
        }

        return {
          threads: newThreads,
          activeThreadId: newActiveId,
        };
      });

      persistThreads();
    },

    /**
     * Set the active thread
     * @param threadId The thread ID to activate
     */
    setActiveThread: (threadId: string): void => {
      update((state) => {
        if (state.threads.some((t) => t.id === threadId)) {
          return { ...state, activeThreadId: threadId };
        }
        return state;
      });

      persistThreads();
    },

    /**
     * Update a thread's title
     * @param threadId The thread ID to update
     * @param title The new title
     */
    updateThreadTitle: (threadId: string, title: string): void => {
      update((state) => ({
        ...state,
        threads: state.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
      }));

      persistThreads();
    },

    /**
     * Get a thread by its session ID
     * @param sessionId The session ID to find
     * @returns The thread or undefined
     */
    getThreadBySessionId: (sessionId: string): SidePanelThread | undefined => {
      const state = get({ subscribe });
      return state.threads.find((t) => t.sessionId === sessionId);
    },

    /**
     * Get the active thread
     * @returns The active thread or undefined
     */
    getActiveThread: (): SidePanelThread | undefined => {
      const state = get({ subscribe });
      return state.threads.find((t) => t.id === state.activeThreadId);
    },

    /**
     * Remove a thread by session ID (for external session termination)
     * @param sessionId The session ID
     */
    removeThreadBySessionId: (sessionId: string): void => {
      const state = get({ subscribe });
      const thread = state.threads.find((t) => t.sessionId === sessionId);
      if (thread) {
        threadStore.closeThread(thread.id);
      }
    },

    /**
     * Restore threads from config storage
     * @returns Promise that resolves with restored state
     */
    restoreThreads: async (): Promise<ThreadStoreState> => {
      try {
        if (!isConfigStorageInitialized()) {
          console.warn('[ThreadStore] ConfigStorage not initialized, skipping restore');
          return initialState;
        }
        const stored = await getConfigStorage().get<ThreadStoreState>(STORAGE_KEY);

        if (stored && stored.threads && stored.threads.length > 0) {
          set(stored);
          return stored;
        }
      } catch (error) {
        console.error('[ThreadStore] Failed to restore threads:', error);
      }

      return initialState;
    },

    /**
     * Clear all threads (for reset)
     */
    clear: (): void => {
      set(initialState);
      persistThreads();
    },

    /**
     * Set the full state (for initialization/restoration)
     */
    setState: (state: ThreadStoreState): void => {
      set(state);
      persistThreads();
    },
  };
}

/**
 * Persist current thread state to config storage
 */
async function persistThreads(): Promise<void> {
  try {
    if (!isConfigStorageInitialized()) {
      console.warn('[ThreadStore] ConfigStorage not initialized, skipping persist');
      return;
    }
    const state = get(threadStore);
    await getConfigStorage().set(STORAGE_KEY, state);
  } catch (error) {
    console.error('[ThreadStore] Failed to persist threads:', error);
  }
}

// Create the store singleton
export const threadStore = createThreadStore();

// Derived store for the active thread
export const activeThread = derived(threadStore, ($threadStore) =>
  $threadStore.threads.find((t) => t.id === $threadStore.activeThreadId)
);

// Derived store for thread count
export const threadCount = derived(threadStore, ($threadStore) => $threadStore.threads.length);
