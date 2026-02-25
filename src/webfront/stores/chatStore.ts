/**
 * Chat Store for Side Panel Multi-Chat Support
 *
 * Manages sidepanel chat UI state using Svelte store.
 * Each chat corresponds to an AgentRegistry session.
 * Persists chat state to chrome.storage.local.
 */

import { writable, derived, get, type Writable } from 'svelte/store';

/**
 * Sidepanel chat representation
 */
export interface SidePanelChat {
  /** Unique chat ID (uuid) */
  id: string;
  /** AgentRegistry session ID */
  sessionId: string;
  /** Display title */
  title: string;
  /** Creation timestamp for ordering */
  createdAt: number;
}

/**
 * Chat store state
 */
export interface ChatStoreState {
  chats: SidePanelChat[];
  activeChatId: string | null;
}

/**
 * Persistence key for chrome.storage.local
 */
const STORAGE_KEY = 'browserx_sidepanel_chats';

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
 * Create the chat store
 */
function createChatStore() {
  const initialState: ChatStoreState = {
    chats: [],
    activeChatId: null,
  };

  const { subscribe, set, update }: Writable<ChatStoreState> = writable(initialState);

  return {
    subscribe,

    /**
     * Create a new chat for a session
     * @param sessionId The AgentRegistry session ID
     * @param title Optional initial title (defaults to "New Chat")
     * @returns The created chat
     */
    createChat: (sessionId: string, title: string = 'New Chat'): SidePanelChat => {
      const newChat: SidePanelChat = {
        id: generateUUID(),
        sessionId,
        title,
        createdAt: Date.now(),
      };

      update((state) => ({
        chats: [...state.chats, newChat],
        activeChatId: newChat.id, // Automatically activate new chat
      }));

      // Persist to storage
      persistChats();

      return newChat;
    },

    /**
     * Close a chat by ID
     * @param chatId The chat ID to close
     */
    closeChat: (chatId: string): void => {
      update((state) => {
        const chatIndex = state.chats.findIndex((c) => c.id === chatId);
        if (chatIndex === -1) return state;

        const newChats = state.chats.filter((c) => c.id !== chatId);

        // If closing the active chat, select another chat
        let newActiveId = state.activeChatId;
        if (state.activeChatId === chatId && newChats.length > 0) {
          // Select the previous chat, or the first if closing the first chat
          const newIndex = Math.min(chatIndex, newChats.length - 1);
          newActiveId = newChats[newIndex]?.id || null;
        } else if (newChats.length === 0) {
          newActiveId = null;
        }

        return {
          chats: newChats,
          activeChatId: newActiveId,
        };
      });

      // Persist to storage
      persistChats();
    },

    /**
     * Set the active chat
     * @param chatId The chat ID to activate
     */
    setActiveChat: (chatId: string): void => {
      update((state) => {
        // Only update if chat exists
        if (state.chats.some((c) => c.id === chatId)) {
          return { ...state, activeChatId: chatId };
        }
        return state;
      });

      // Persist to storage
      persistChats();
    },

    /**
     * Update a chat's title
     * @param chatId The chat ID to update
     * @param title The new title
     */
    updateChatTitle: (chatId: string, title: string): void => {
      update((state) => ({
        ...state,
        chats: state.chats.map((c) => (c.id === chatId ? { ...c, title } : c)),
      }));

      // Persist to storage
      persistChats();
    },

    /**
     * Get a chat by its session ID
     * @param sessionId The session ID to find
     * @returns The chat or undefined
     */
    getChatBySessionId: (sessionId: string): SidePanelChat | undefined => {
      const state = get({ subscribe });
      return state.chats.find((c) => c.sessionId === sessionId);
    },

    /**
     * Get the active chat
     * @returns The active chat or undefined
     */
    getActiveChat: (): SidePanelChat | undefined => {
      const state = get({ subscribe });
      return state.chats.find((c) => c.id === state.activeChatId);
    },

    /**
     * Remove a chat by session ID (for external session termination)
     * @param sessionId The session ID
     */
    removeChatBySessionId: (sessionId: string): void => {
      const state = get({ subscribe });
      const chat = state.chats.find((c) => c.sessionId === sessionId);
      if (chat) {
        chatStore.closeChat(chat.id);
      }
    },

    /**
     * Restore chats from chrome.storage.local
     * @returns Promise that resolves with restored state
     */
    restoreChats: async (): Promise<ChatStoreState> => {
      try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const stored = result[STORAGE_KEY] as ChatStoreState | undefined;

        if (stored && stored.chats && stored.chats.length > 0) {
          set(stored);
          return stored;
        }
      } catch (error) {
        console.error('[ChatStore] Failed to restore chats:', error);
      }

      return initialState;
    },

    /**
     * Clear all chats (for reset)
     */
    clear: (): void => {
      set(initialState);
      persistChats();
    },

    /**
     * Set the full state (for initialization/restoration)
     */
    setState: (state: ChatStoreState): void => {
      set(state);
      persistChats();
    },
  };
}

/**
 * Persist current chat state to chrome.storage.local
 */
async function persistChats(): Promise<void> {
  try {
    const state = get(chatStore);
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (error) {
    console.error('[ChatStore] Failed to persist chats:', error);
  }
}

// Create the store singleton
export const chatStore = createChatStore();

// Derived store for the active chat
export const activeChat = derived(chatStore, ($chatStore) =>
  $chatStore.chats.find((c) => c.id === $chatStore.activeChatId)
);

// Derived store for chat count
export const chatCount = derived(chatStore, ($chatStore) => $chatStore.chats.length);
