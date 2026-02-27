/**
 * Unit tests for chatStore — multi-chat tab management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// Mock ConfigStorageProvider before importing chatStore
const mockConfigStorage = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => mockConfigStorage),
}));

import { chatStore, activeChat, chatCount } from '@/webfront/stores/chatStore';
import type { ChatStoreState } from '@/webfront/stores/chatStore';
import { isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

describe('chatStore', () => {
  beforeEach(() => {
    chatStore.clear();
    vi.clearAllMocks();
    // Re-setup mocks after clearAllMocks (because of mockReset: true in vitest config)
    vi.mocked(isConfigStorageInitialized).mockReturnValue(true);
    mockConfigStorage.get.mockResolvedValue(null);
    mockConfigStorage.set.mockResolvedValue(undefined);
  });

  // =========================================================================
  // createChat
  // =========================================================================

  describe('createChat', () => {
    it('creates a chat with the given sessionId', () => {
      const chat = chatStore.createChat('session_abc');

      expect(chat.sessionId).toBe('session_abc');
      expect(chat.id).toBeTruthy();
      expect(chat.title).toBe('New Chat');
      expect(chat.createdAt).toBeGreaterThan(0);
    });

    it('auto-activates the newly created chat', () => {
      const chat = chatStore.createChat('session_abc');
      const state = get(chatStore);

      expect(state.activeChatId).toBe(chat.id);
    });

    it('assigns unique IDs to each chat', () => {
      const chat1 = chatStore.createChat('session_1');
      const chat2 = chatStore.createChat('session_2');

      expect(chat1.id).not.toBe(chat2.id);
    });

    it('uses a custom title when provided', () => {
      const chat = chatStore.createChat('session_x', 'My Custom Chat');

      expect(chat.title).toBe('My Custom Chat');
    });

    it('persists to config storage', () => {
      chatStore.createChat('session_1');

      expect(mockConfigStorage.set).toHaveBeenCalled();
    });

    it('adds chat to the chats array', () => {
      chatStore.createChat('s1');
      chatStore.createChat('s2');
      const state = get(chatStore);

      expect(state.chats).toHaveLength(2);
    });

    it('activates the last created chat when multiple are created', () => {
      chatStore.createChat('s1');
      const chat2 = chatStore.createChat('s2');
      const state = get(chatStore);

      expect(state.activeChatId).toBe(chat2.id);
    });
  });

  // =========================================================================
  // closeChat
  // =========================================================================

  describe('closeChat', () => {
    it('removes the specified chat', () => {
      const chat = chatStore.createChat('s1');
      chatStore.createChat('s2');
      chatStore.closeChat(chat.id);

      const state = get(chatStore);
      expect(state.chats.find((c) => c.id === chat.id)).toBeUndefined();
    });

    it('selects an adjacent chat when closing the active chat', () => {
      const chat1 = chatStore.createChat('s1');
      const chat2 = chatStore.createChat('s2');
      chatStore.createChat('s3');

      // chat3 is active (last created). Switch to chat2, then close it.
      chatStore.setActiveChat(chat2.id);
      chatStore.closeChat(chat2.id);

      const state = get(chatStore);
      // Should pick the chat at the same index or previous
      expect(state.activeChatId).not.toBe(chat2.id);
      expect(state.chats.some((c) => c.id === state.activeChatId)).toBe(true);
    });

    it('sets activeChatId to null when closing the last chat', () => {
      const chat = chatStore.createChat('s1');
      chatStore.closeChat(chat.id);

      const state = get(chatStore);
      expect(state.activeChatId).toBeNull();
      expect(state.chats).toHaveLength(0);
    });

    it('is a no-op for an unknown chat ID', () => {
      chatStore.createChat('s1');
      const stateBefore = get(chatStore);

      chatStore.closeChat('nonexistent');

      const stateAfter = get(chatStore);
      expect(stateAfter.chats).toEqual(stateBefore.chats);
    });

    it('selects the first chat when closing the first chat', () => {
      const chat1 = chatStore.createChat('s1');
      const chat2 = chatStore.createChat('s2');
      // Activate and close the first chat
      chatStore.setActiveChat(chat1.id);
      chatStore.closeChat(chat1.id);

      const state = get(chatStore);
      expect(state.activeChatId).toBe(chat2.id);
    });

    it('persists after closing', () => {
      const chat = chatStore.createChat('s1');
      vi.mocked(mockConfigStorage.set).mockClear();

      chatStore.closeChat(chat.id);
      expect(mockConfigStorage.set).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // setActiveChat
  // =========================================================================

  describe('setActiveChat', () => {
    it('sets the active chat ID', () => {
      const chat1 = chatStore.createChat('s1');
      chatStore.createChat('s2');

      chatStore.setActiveChat(chat1.id);
      const state = get(chatStore);

      expect(state.activeChatId).toBe(chat1.id);
    });

    it('is a no-op for a nonexistent chat ID', () => {
      chatStore.createChat('s1');
      const stateBefore = get(chatStore);

      chatStore.setActiveChat('nonexistent');
      const stateAfter = get(chatStore);

      expect(stateAfter.activeChatId).toBe(stateBefore.activeChatId);
    });
  });

  // =========================================================================
  // updateChatTitle
  // =========================================================================

  describe('updateChatTitle', () => {
    it('updates the title of the specified chat', () => {
      const chat = chatStore.createChat('s1');
      chatStore.updateChatTitle(chat.id, 'Renamed Chat');

      const state = get(chatStore);
      expect(state.chats.find((c) => c.id === chat.id)?.title).toBe('Renamed Chat');
    });

    it('does not affect other chats', () => {
      const chat1 = chatStore.createChat('s1', 'Chat A');
      const chat2 = chatStore.createChat('s2', 'Chat B');

      chatStore.updateChatTitle(chat1.id, 'Updated A');

      const state = get(chatStore);
      expect(state.chats.find((c) => c.id === chat2.id)?.title).toBe('Chat B');
    });
  });

  // =========================================================================
  // getChatBySessionId
  // =========================================================================

  describe('getChatBySessionId', () => {
    it('returns the chat matching the sessionId', () => {
      const chat = chatStore.createChat('session_123');
      const found = chatStore.getChatBySessionId('session_123');

      expect(found?.id).toBe(chat.id);
    });

    it('returns undefined for an unknown sessionId', () => {
      chatStore.createChat('session_abc');
      const found = chatStore.getChatBySessionId('unknown');

      expect(found).toBeUndefined();
    });
  });

  // =========================================================================
  // getActiveChat
  // =========================================================================

  describe('getActiveChat', () => {
    it('returns the active chat', () => {
      const chat = chatStore.createChat('s1');
      const active = chatStore.getActiveChat();

      expect(active?.id).toBe(chat.id);
    });

    it('returns undefined when no chats exist', () => {
      expect(chatStore.getActiveChat()).toBeUndefined();
    });

    it('returns undefined after clearing all chats', () => {
      chatStore.createChat('s1');
      chatStore.clear();

      expect(chatStore.getActiveChat()).toBeUndefined();
    });
  });

  // =========================================================================
  // removeChatBySessionId
  // =========================================================================

  describe('removeChatBySessionId', () => {
    it('finds and removes the chat by sessionId', () => {
      chatStore.createChat('session_to_remove');
      chatStore.createChat('session_to_keep');

      chatStore.removeChatBySessionId('session_to_remove');

      const state = get(chatStore);
      expect(state.chats).toHaveLength(1);
      expect(state.chats[0].sessionId).toBe('session_to_keep');
    });

    it('is a no-op for an unknown sessionId', () => {
      chatStore.createChat('s1');
      const before = get(chatStore);

      chatStore.removeChatBySessionId('nonexistent');

      const after = get(chatStore);
      expect(after.chats).toHaveLength(before.chats.length);
    });
  });

  // =========================================================================
  // restoreChats
  // =========================================================================

  describe('restoreChats', () => {
    it('restores chats from config storage', async () => {
      const stored: ChatStoreState = {
        chats: [
          { id: 'c1', sessionId: 's1', title: 'Restored', createdAt: 1000 },
        ],
        activeChatId: 'c1',
      };
      mockConfigStorage.get.mockResolvedValue(stored);

      const result = await chatStore.restoreChats();

      expect(result.chats).toHaveLength(1);
      expect(result.chats[0].title).toBe('Restored');
      const state = get(chatStore);
      expect(state.chats).toHaveLength(1);
    });

    it('returns initial state when storage is empty', async () => {
      mockConfigStorage.get.mockResolvedValue(null);

      const result = await chatStore.restoreChats();

      expect(result.chats).toHaveLength(0);
      expect(result.activeChatId).toBeNull();
    });

    it('returns initial state when storage has empty chats array', async () => {
      mockConfigStorage.get.mockResolvedValue({ chats: [], activeChatId: null });

      const result = await chatStore.restoreChats();

      expect(result.chats).toHaveLength(0);
    });

    it('handles storage errors gracefully', async () => {
      mockConfigStorage.get.mockRejectedValue(new Error('Storage failure'));

      const result = await chatStore.restoreChats();

      expect(result.chats).toHaveLength(0);
    });

    it('skips restore when ConfigStorage is not initialized', async () => {
      vi.mocked(isConfigStorageInitialized).mockReturnValue(false);

      const result = await chatStore.restoreChats();

      expect(result.chats).toHaveLength(0);
      expect(mockConfigStorage.get).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // clear / setState
  // =========================================================================

  describe('clear', () => {
    it('resets all chats and activeChatId', () => {
      chatStore.createChat('s1');
      chatStore.createChat('s2');
      chatStore.clear();

      const state = get(chatStore);
      expect(state.chats).toHaveLength(0);
      expect(state.activeChatId).toBeNull();
    });
  });

  describe('setState', () => {
    it('replaces the full state', () => {
      chatStore.createChat('original');

      const newState: ChatStoreState = {
        chats: [
          { id: 'x1', sessionId: 'sx1', title: 'Set', createdAt: 500 },
          { id: 'x2', sessionId: 'sx2', title: 'State', createdAt: 600 },
        ],
        activeChatId: 'x2',
      };

      chatStore.setState(newState);

      const state = get(chatStore);
      expect(state.chats).toHaveLength(2);
      expect(state.activeChatId).toBe('x2');
    });

    it('persists the new state', () => {
      vi.mocked(mockConfigStorage.set).mockClear();
      chatStore.setState({ chats: [], activeChatId: null });

      expect(mockConfigStorage.set).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Derived stores
  // =========================================================================

  describe('activeChat derived store', () => {
    it('reflects the currently active chat', () => {
      const chat = chatStore.createChat('s1');
      const active = get(activeChat);

      expect(active?.id).toBe(chat.id);
    });

    it('is undefined when no chats exist', () => {
      expect(get(activeChat)).toBeUndefined();
    });
  });

  describe('chatCount derived store', () => {
    it('reflects the number of chats', () => {
      expect(get(chatCount)).toBe(0);

      chatStore.createChat('s1');
      expect(get(chatCount)).toBe(1);

      chatStore.createChat('s2');
      expect(get(chatCount)).toBe(2);
    });

    it('decrements when a chat is closed', () => {
      const chat = chatStore.createChat('s1');
      chatStore.createChat('s2');

      chatStore.closeChat(chat.id);
      expect(get(chatCount)).toBe(1);
    });
  });
});
