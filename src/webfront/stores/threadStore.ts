/**
 * Thread Store for Side Panel Multi-Thread Support
 *
 * Manages sidepanel thread UI state using Svelte store.
 * Each thread corresponds to an AgentRegistry session.
 * sessionId is the universal key — same value used in UI, registry, and runtime.
 * Persists thread state via ConfigStorageProvider.
 */

import { writable, derived, get, type Writable } from 'svelte/store';
import { getConfigStorage, isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';
import type { AgentMode } from '@/prompts/PromptComposer';

/**
 * Sidepanel thread representation
 * sessionId is the universal identifier (same as AgentSession.sessionId and Session.sessionId)
 */
export interface SidePanelThread {
  /** Universal session ID (same across UI, registry, and runtime) */
  sessionId: string;
  /** Display title */
  title: string;
  /** Creation timestamp for ordering */
  createdAt: number;
  /**
   * Active agent persona mode for this session. Undefined = not yet known
   * (treat as the default mode). Committed only from a backend ModeChanged
   * event — never optimistically.
   */
  mode?: AgentMode;
  /**
   * A mode the user requested that is awaiting application (the session had a
   * task in flight). Drives the "switching after current task…" UI. Cleared
   * when the backend confirms the switch applied.
   */
  pendingMode?: AgentMode | null;
}

/**
 * Thread store state
 */
export interface ThreadStoreState {
  threads: SidePanelThread[];
  activeSessionId: string | null;
}

/**
 * Persistence key for config storage
 */
const STORAGE_KEY = 'browserx_sidepanel_threads';

/**
 * Create the thread store
 */
function createThreadStore() {
  const initialState: ThreadStoreState = {
    threads: [],
    activeSessionId: null,
  };

  const { subscribe, set, update }: Writable<ThreadStoreState> = writable(initialState);

  return {
    subscribe,

    /**
     * Create a new thread for a session
     * @param sessionId The universal session ID
     * @param title Optional initial title (defaults to "New Thread")
     * @returns The created thread
     */
    createThread: (sessionId: string, title: string = 'New Thread'): SidePanelThread => {
      const newThread: SidePanelThread = {
        sessionId,
        title,
        createdAt: Date.now(),
      };

      update((state) => ({
        threads: [...state.threads, newThread],
        activeSessionId: newThread.sessionId,
      }));

      persistThreads();

      return newThread;
    },

    /**
     * Close a thread by session ID
     * @param sessionId The session ID to close
     */
    closeThread: (sessionId: string): void => {
      update((state) => {
        const threadIndex = state.threads.findIndex((t) => t.sessionId === sessionId);
        if (threadIndex === -1) return state;

        const newThreads = state.threads.filter((t) => t.sessionId !== sessionId);

        let newActiveId = state.activeSessionId;
        if (state.activeSessionId === sessionId && newThreads.length > 0) {
          const newIndex = Math.min(threadIndex, newThreads.length - 1);
          newActiveId = newThreads[newIndex]?.sessionId || null;
        } else if (newThreads.length === 0) {
          newActiveId = null;
        }

        return {
          threads: newThreads,
          activeSessionId: newActiveId,
        };
      });

      persistThreads();
    },

    /**
     * Set the active thread by session ID
     * @param sessionId The session ID to activate
     */
    setActiveThread: (sessionId: string): void => {
      update((state) => {
        if (state.threads.some((t) => t.sessionId === sessionId)) {
          return { ...state, activeSessionId: sessionId };
        }
        return state;
      });

      persistThreads();
    },

    /**
     * Update a thread's title
     * @param sessionId The session ID of the thread to update
     * @param title The new title
     */
    updateThreadTitle: (sessionId: string, title: string): void => {
      update((state) => ({
        ...state,
        threads: state.threads.map((t) => (t.sessionId === sessionId ? { ...t, title } : t)),
      }));

      persistThreads();
    },

    /**
     * Commit a thread's active mode (from a backend ModeChanged event).
     * Also clears any pendingMode since the switch has now settled.
     * @param sessionId The session ID of the thread
     * @param mode The applied agent mode
     */
    setThreadMode: (sessionId: string, mode: AgentMode): void => {
      update((state) => ({
        ...state,
        threads: state.threads.map((t) =>
          t.sessionId === sessionId ? { ...t, mode, pendingMode: null } : t
        ),
      }));

      persistThreads();
    },

    /**
     * Set (or clear) a thread's pending mode — the user requested a switch but
     * a task is in flight. Pass null to clear.
     * @param sessionId The session ID of the thread
     * @param mode The requested mode, or null to clear
     */
    setThreadPendingMode: (sessionId: string, mode: AgentMode | null): void => {
      update((state) => ({
        ...state,
        threads: state.threads.map((t) =>
          t.sessionId === sessionId ? { ...t, pendingMode: mode } : t
        ),
      }));

      persistThreads();
    },

    /**
     * Get a thread by session ID (direct lookup)
     * @param sessionId The session ID to find
     * @returns The thread or undefined
     */
    getThread: (sessionId: string): SidePanelThread | undefined => {
      const state = get({ subscribe });
      return state.threads.find((t) => t.sessionId === sessionId);
    },

    /**
     * Get the active thread
     * @returns The active thread or undefined
     */
    getActiveThread: (): SidePanelThread | undefined => {
      const state = get({ subscribe });
      return state.threads.find((t) => t.sessionId === state.activeSessionId);
    },

    /**
     * Remove a thread by session ID
     * @param sessionId The session ID
     */
    removeThread: (sessionId: string): void => {
      threadStore.closeThread(sessionId);
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
  $threadStore.threads.find((t) => t.sessionId === $threadStore.activeSessionId)
);

// Derived store for thread count
export const threadCount = derived(threadStore, ($threadStore) => $threadStore.threads.length);
