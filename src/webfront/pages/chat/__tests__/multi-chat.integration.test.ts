/**
 * Multi-chat integration tests
 *
 * Tests the UI-side state management logic extracted from Main.svelte:
 * saveChatState, loadChatState, handleEventForSession, switchToChat,
 * welcome screen condition, and full independence scenarios.
 *
 * Uses a MultiChatStateManager class that replicates Main.svelte's
 * pure state logic so we can test without mounting the full component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// ---------- Mock ConfigStorageProvider ----------

const mockConfigStorage = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => mockConfigStorage),
}));

import { chatStore } from '@/webfront/stores/chatStore';
import { isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

// ---------- Types matching Main.svelte ----------

interface Message {
  type: 'user' | 'agent';
  content: string;
  timestamp: number;
}

interface ProcessedEvent {
  id: string;
  [key: string]: any;
}

interface MockEventProcessor {
  processEvent: (event: any) => ProcessedEvent | null;
}

interface ChatConversationState {
  messages: Message[];
  processedEvents: ProcessedEvent[];
  inputText: string;
  isProcessing: boolean;
  currentTabId: number;
  eventProcessor: MockEventProcessor;
}

// ---------- MultiChatStateManager (replicates Main.svelte logic) ----------

function createMockEventProcessor(): MockEventProcessor {
  return {
    processEvent: vi.fn((event: any) => ({
      id: `pe_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: event.msg?.type ?? 'unknown',
      raw: event,
    })),
  };
}

class MultiChatStateManager {
  chatStates = new Map<string, ChatConversationState>();
  activeSessionId: string | null = null;

  // "UI state" — mimics the reactive variables in Main.svelte
  messages: Message[] = [];
  processedEvents: ProcessedEvent[] = [];
  inputText: string = '';
  isProcessing: boolean = false;
  currentTabId: number = -1;
  eventProcessor: MockEventProcessor = createMockEventProcessor();

  /** Save current UI state to the chatStates map */
  saveChatState(chatId: string) {
    const state: ChatConversationState = {
      messages: [...this.messages],
      processedEvents: [...this.processedEvents],
      inputText: this.inputText,
      isProcessing: this.isProcessing,
      currentTabId: this.currentTabId,
      eventProcessor: this.eventProcessor,
    };
    this.chatStates.set(chatId, state);
  }

  /** Load chat state from map to UI */
  loadChatState(chatId: string) {
    const state = this.chatStates.get(chatId);
    if (state) {
      this.messages = [...state.messages];
      this.processedEvents = [...state.processedEvents];
      this.inputText = state.inputText;
      this.isProcessing = state.isProcessing;
      this.currentTabId = state.currentTabId;
      this.eventProcessor = state.eventProcessor;
    } else {
      this.messages = [];
      this.processedEvents = [];
      this.inputText = '';
      this.isProcessing = false;
      this.currentTabId = -1;
      this.eventProcessor = createMockEventProcessor();
    }
  }

  /** Handle incoming event for a specific session (background chat) */
  handleEventForSession(event: { id: string; msg: { type: string; [key: string]: any } }, sessionId: string) {
    const chat = chatStore.getChatBySessionId(sessionId);
    if (!chat) return;

    let state = this.chatStates.get(chat.id);
    if (!state) {
      state = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: createMockEventProcessor(),
      };
      this.chatStates.set(chat.id, state);
    }

    const processed = state.eventProcessor.processEvent(event);
    if (processed) {
      state.processedEvents = [...state.processedEvents, processed];
    }

    const msg = event.msg;
    if (msg.type === 'TaskStarted') {
      state.isProcessing = true;
    } else if (msg.type === 'TaskComplete' || msg.type === 'TaskFailed') {
      state.isProcessing = false;
    }

    this.chatStates.set(chat.id, state);
  }

  /** Switch to a specific chat (replicates switchToChat in Main.svelte) */
  switchToChat(chatId: string) {
    const currentActiveChat = chatStore.getActiveChat();
    if (currentActiveChat) {
      this.saveChatState(currentActiveChat.id);
    }

    chatStore.setActiveChat(chatId);

    const newChat = chatStore.getActiveChat();
    if (newChat) {
      this.activeSessionId = newChat.sessionId;
    }

    this.loadChatState(chatId);
  }

  /** Welcome screen condition */
  get showWelcome(): boolean {
    return !this.isProcessing && this.processedEvents.length === 0 && this.messages.length === 0;
  }
}

// ---------- Tests ----------

describe('Multi-chat integration (UI state management)', () => {
  let mgr: MultiChatStateManager;

  beforeEach(() => {
    chatStore.clear();
    vi.clearAllMocks();
    vi.mocked(isConfigStorageInitialized).mockReturnValue(true);
    mockConfigStorage.get.mockResolvedValue(null);
    mockConfigStorage.set.mockResolvedValue(undefined);

    mgr = new MultiChatStateManager();
  });

  // =========================================================================
  // saveChatState / loadChatState roundtrip
  // =========================================================================

  describe('saveChatState / loadChatState roundtrip', () => {
    it('preserves all fields', () => {
      const chat = chatStore.createChat('s1');

      mgr.messages = [{ type: 'user', content: 'hi', timestamp: 1 }];
      mgr.processedEvents = [{ id: 'pe1', type: 'AgentMessage' }];
      mgr.inputText = 'draft';
      mgr.isProcessing = true;
      mgr.currentTabId = 42;

      mgr.saveChatState(chat.id);

      // Nuke UI state
      mgr.messages = [];
      mgr.processedEvents = [];
      mgr.inputText = '';
      mgr.isProcessing = false;
      mgr.currentTabId = -1;

      mgr.loadChatState(chat.id);

      expect(mgr.messages).toEqual([{ type: 'user', content: 'hi', timestamp: 1 }]);
      expect(mgr.processedEvents).toEqual([{ id: 'pe1', type: 'AgentMessage' }]);
      expect(mgr.inputText).toBe('draft');
      expect(mgr.isProcessing).toBe(true);
      expect(mgr.currentTabId).toBe(42);
    });

    it('produces defensive copies (mutating UI state does not corrupt saved state)', () => {
      const chat = chatStore.createChat('s1');

      mgr.messages = [{ type: 'user', content: 'original', timestamp: 1 }];
      mgr.saveChatState(chat.id);

      // Mutate the current UI array
      mgr.messages.push({ type: 'agent', content: 'extra', timestamp: 2 });

      // Reload — should get the original snapshot
      mgr.loadChatState(chat.id);
      expect(mgr.messages).toHaveLength(1);
      expect(mgr.messages[0].content).toBe('original');
    });

    it('gives each chat its own EventProcessor instance', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      mgr.saveChatState(c1.id);
      const ep1 = mgr.eventProcessor;

      mgr.eventProcessor = createMockEventProcessor();
      mgr.saveChatState(c2.id);

      mgr.loadChatState(c1.id);
      const ep1Loaded = mgr.eventProcessor;

      mgr.loadChatState(c2.id);
      const ep2Loaded = mgr.eventProcessor;

      expect(ep1Loaded).toBe(ep1);
      expect(ep1Loaded).not.toBe(ep2Loaded);
    });
  });

  // =========================================================================
  // loadChatState for missing chat
  // =========================================================================

  describe('loadChatState for missing chat', () => {
    it('initializes fresh state when no saved state exists', () => {
      mgr.messages = [{ type: 'user', content: 'stale', timestamp: 99 }];

      mgr.loadChatState('nonexistent-id');

      expect(mgr.messages).toEqual([]);
      expect(mgr.processedEvents).toEqual([]);
      expect(mgr.inputText).toBe('');
      expect(mgr.isProcessing).toBe(false);
      expect(mgr.currentTabId).toBe(-1);
    });
  });

  // =========================================================================
  // Event routing — handleEventForSession
  // =========================================================================

  describe('handleEventForSession', () => {
    it('stores event in the correct background chat', () => {
      const chat1 = chatStore.createChat('session_1');
      const chat2 = chatStore.createChat('session_2');

      const event = { id: 'evt_1', msg: { type: 'AgentMessage', data: {} } };
      mgr.handleEventForSession(event, 'session_1');

      const state1 = mgr.chatStates.get(chat1.id);
      const state2 = mgr.chatStates.get(chat2.id);

      expect(state1?.processedEvents).toHaveLength(1);
      expect(state2).toBeUndefined(); // Not touched
    });

    it('does not affect active UI state', () => {
      chatStore.createChat('session_bg');

      mgr.messages = [{ type: 'user', content: 'current', timestamp: 1 }];
      mgr.processedEvents = [];

      mgr.handleEventForSession(
        { id: 'evt_2', msg: { type: 'AgentMessage', data: {} } },
        'session_bg'
      );

      // Active UI is untouched
      expect(mgr.processedEvents).toHaveLength(0);
    });

    it('creates state on demand for a chat without prior state', () => {
      const chat = chatStore.createChat('session_new');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'AgentMessage', data: {} } },
        'session_new'
      );

      expect(mgr.chatStates.has(chat.id)).toBe(true);
      expect(mgr.chatStates.get(chat.id)?.processedEvents).toHaveLength(1);
    });

    it('ignores unknown sessionId', () => {
      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'AgentMessage', data: {} } },
        'unknown_session'
      );

      expect(mgr.chatStates.size).toBe(0);
    });

    it('sets isProcessing=true on TaskStarted', () => {
      const chat = chatStore.createChat('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );

      expect(mgr.chatStates.get(chat.id)?.isProcessing).toBe(true);
    });

    it('sets isProcessing=false on TaskComplete', () => {
      const chat = chatStore.createChat('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );
      mgr.handleEventForSession(
        { id: 'e2', msg: { type: 'TaskComplete', data: {} } },
        'session_x'
      );

      expect(mgr.chatStates.get(chat.id)?.isProcessing).toBe(false);
    });

    it('sets isProcessing=false on TaskFailed', () => {
      const chat = chatStore.createChat('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );
      mgr.handleEventForSession(
        { id: 'e2', msg: { type: 'TaskFailed', data: {} } },
        'session_x'
      );

      expect(mgr.chatStates.get(chat.id)?.isProcessing).toBe(false);
    });
  });

  // =========================================================================
  // switchToChat
  // =========================================================================

  describe('switchToChat', () => {
    it('saves old state and loads new state', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      // Put some state on c1
      chatStore.setActiveChat(c1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'chat1 msg', timestamp: 1 }];
      mgr.inputText = 'draft1';

      // Switch to c2
      mgr.switchToChat(c2.id);

      // c2 should have fresh state
      expect(mgr.messages).toEqual([]);
      expect(mgr.inputText).toBe('');
      expect(mgr.activeSessionId).toBe('s2');

      // Switch back to c1 — should restore saved state
      mgr.switchToChat(c1.id);

      expect(mgr.messages).toEqual([{ type: 'user', content: 'chat1 msg', timestamp: 1 }]);
      expect(mgr.inputText).toBe('draft1');
      expect(mgr.activeSessionId).toBe('s1');
    });

    it('updates activeSessionId', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      chatStore.setActiveChat(c1.id);
      mgr.switchToChat(c2.id);

      expect(mgr.activeSessionId).toBe('s2');
    });
  });

  // =========================================================================
  // Welcome screen condition
  // =========================================================================

  describe('welcome screen condition', () => {
    it('shows welcome when chat is empty and not processing', () => {
      expect(mgr.showWelcome).toBe(true);
    });

    it('hides welcome when processing', () => {
      mgr.isProcessing = true;
      expect(mgr.showWelcome).toBe(false);
    });

    it('hides welcome when there are processed events', () => {
      mgr.processedEvents = [{ id: 'pe1' }];
      expect(mgr.showWelcome).toBe(false);
    });

    it('hides welcome when there are messages', () => {
      mgr.messages = [{ type: 'user', content: 'hello', timestamp: 1 }];
      expect(mgr.showWelcome).toBe(false);
    });
  });

  // =========================================================================
  // Full independence scenario
  // =========================================================================

  describe('full independence', () => {
    it('two chats maintain independent message histories', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      // Start on c1
      chatStore.setActiveChat(c1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'msg_c1', timestamp: 1 }];
      mgr.saveChatState(c1.id);

      // Switch to c2, add different messages
      mgr.switchToChat(c2.id);
      mgr.messages = [{ type: 'agent', content: 'msg_c2', timestamp: 2 }];
      mgr.saveChatState(c2.id);

      // Load c1 — should see c1's messages
      mgr.loadChatState(c1.id);
      expect(mgr.messages).toEqual([{ type: 'user', content: 'msg_c1', timestamp: 1 }]);

      // Load c2 — should see c2's messages
      mgr.loadChatState(c2.id);
      expect(mgr.messages).toEqual([{ type: 'agent', content: 'msg_c2', timestamp: 2 }]);
    });

    it('processing state does not cross between chats', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      // Start processing on c1 via background event
      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        's1'
      );

      // c1 should be processing
      expect(mgr.chatStates.get(c1.id)?.isProcessing).toBe(true);

      // c2 should NOT be processing (state doesn't even exist yet)
      expect(mgr.chatStates.get(c2.id)?.isProcessing).toBeUndefined();
    });

    it('background events accumulate correctly for each chat', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      // Send events to both chats in background
      mgr.handleEventForSession({ id: 'e1', msg: { type: 'AgentMessage', data: {} } }, 's1');
      mgr.handleEventForSession({ id: 'e2', msg: { type: 'AgentMessage', data: {} } }, 's1');
      mgr.handleEventForSession({ id: 'e3', msg: { type: 'AgentMessage', data: {} } }, 's2');

      expect(mgr.chatStates.get(c1.id)?.processedEvents).toHaveLength(2);
      expect(mgr.chatStates.get(c2.id)?.processedEvents).toHaveLength(1);
    });

    it('switching chats reveals accumulated background events', () => {
      const c1 = chatStore.createChat('s1');
      const c2 = chatStore.createChat('s2');

      // Simulate: active on c1, background events arrive for c2
      chatStore.setActiveChat(c1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'active chat', timestamp: 1 }];

      mgr.handleEventForSession({ id: 'bg1', msg: { type: 'AgentMessage', data: {} } }, 's2');
      mgr.handleEventForSession({ id: 'bg2', msg: { type: 'AgentMessage', data: {} } }, 's2');

      // Switch to c2
      mgr.switchToChat(c2.id);

      // Should see the 2 accumulated events
      expect(mgr.processedEvents).toHaveLength(2);
      expect(mgr.messages).toEqual([]);
    });
  });
});
