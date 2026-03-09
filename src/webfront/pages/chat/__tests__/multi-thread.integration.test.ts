/**
 * Multi-thread integration tests
 *
 * Tests the UI-side state management logic extracted from Main.svelte:
 * saveThreadState, loadThreadState, handleEventForSession, switchToThread,
 * welcome screen condition, and full independence scenarios.
 *
 * Uses a MultiThreadStateManager class that replicates Main.svelte's
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

import { threadStore } from '@/webfront/stores/threadStore';
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

interface ThreadConversationState {
  messages: Message[];
  processedEvents: ProcessedEvent[];
  inputText: string;
  isProcessing: boolean;
  currentTabId: number;
  eventProcessor: MockEventProcessor;
}

// ---------- MultiThreadStateManager (replicates Main.svelte logic) ----------

function createMockEventProcessor(): MockEventProcessor {
  return {
    processEvent: vi.fn((event: any) => ({
      id: `pe_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: event.msg?.type ?? 'unknown',
      raw: event,
    })),
  };
}

class MultiThreadStateManager {
  threadStates = new Map<string, ThreadConversationState>();
  activeSessionId: string | null = null;

  // "UI state" — mimics the reactive variables in Main.svelte
  messages: Message[] = [];
  processedEvents: ProcessedEvent[] = [];
  inputText: string = '';
  isProcessing: boolean = false;
  currentTabId: number = -1;
  eventProcessor: MockEventProcessor = createMockEventProcessor();

  /** Save current UI state to the threadStates map */
  saveThreadState(threadId: string) {
    const state: ThreadConversationState = {
      messages: [...this.messages],
      processedEvents: [...this.processedEvents],
      inputText: this.inputText,
      isProcessing: this.isProcessing,
      currentTabId: this.currentTabId,
      eventProcessor: this.eventProcessor,
    };
    this.threadStates.set(threadId, state);
  }

  /** Load thread state from map to UI */
  loadThreadState(threadId: string) {
    const state = this.threadStates.get(threadId);
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

  /** Handle incoming event for a specific session (background thread) */
  handleEventForSession(event: { id: string; msg: { type: string; [key: string]: any } }, sessionId: string) {
    const thread = threadStore.getThreadBySessionId(sessionId);
    if (!thread) return;

    let state = this.threadStates.get(thread.id);
    if (!state) {
      state = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: createMockEventProcessor(),
      };
      this.threadStates.set(thread.id, state);
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

    this.threadStates.set(thread.id, state);
  }

  /** Switch to a specific thread (replicates switchToThread in Main.svelte) */
  switchToThread(threadId: string) {
    const currentActiveThread = threadStore.getActiveThread();
    if (currentActiveThread) {
      this.saveThreadState(currentActiveThread.id);
    }

    threadStore.setActiveThread(threadId);

    const newThread = threadStore.getActiveThread();
    if (newThread) {
      this.activeSessionId = newThread.sessionId;
    }

    this.loadThreadState(threadId);
  }

  /** Welcome screen condition */
  get showWelcome(): boolean {
    return !this.isProcessing && this.processedEvents.length === 0 && this.messages.length === 0;
  }
}

// ---------- Tests ----------

describe('Multi-thread integration (UI state management)', () => {
  let mgr: MultiThreadStateManager;

  beforeEach(() => {
    threadStore.clear();
    vi.clearAllMocks();
    vi.mocked(isConfigStorageInitialized).mockReturnValue(true);
    mockConfigStorage.get.mockResolvedValue(null);
    mockConfigStorage.set.mockResolvedValue(undefined);

    mgr = new MultiThreadStateManager();
  });

  // =========================================================================
  // saveThreadState / loadThreadState roundtrip
  // =========================================================================

  describe('saveThreadState / loadThreadState roundtrip', () => {
    it('preserves all fields', () => {
      const thread = threadStore.createThread('s1');

      mgr.messages = [{ type: 'user', content: 'hi', timestamp: 1 }];
      mgr.processedEvents = [{ id: 'pe1', type: 'AgentMessage' }];
      mgr.inputText = 'draft';
      mgr.isProcessing = true;
      mgr.currentTabId = 42;

      mgr.saveThreadState(thread.id);

      // Nuke UI state
      mgr.messages = [];
      mgr.processedEvents = [];
      mgr.inputText = '';
      mgr.isProcessing = false;
      mgr.currentTabId = -1;

      mgr.loadThreadState(thread.id);

      expect(mgr.messages).toEqual([{ type: 'user', content: 'hi', timestamp: 1 }]);
      expect(mgr.processedEvents).toEqual([{ id: 'pe1', type: 'AgentMessage' }]);
      expect(mgr.inputText).toBe('draft');
      expect(mgr.isProcessing).toBe(true);
      expect(mgr.currentTabId).toBe(42);
    });

    it('produces defensive copies (mutating UI state does not corrupt saved state)', () => {
      const thread = threadStore.createThread('s1');

      mgr.messages = [{ type: 'user', content: 'original', timestamp: 1 }];
      mgr.saveThreadState(thread.id);

      // Mutate the current UI array
      mgr.messages.push({ type: 'agent', content: 'extra', timestamp: 2 });

      // Reload — should get the original snapshot
      mgr.loadThreadState(thread.id);
      expect(mgr.messages).toHaveLength(1);
      expect(mgr.messages[0].content).toBe('original');
    });

    it('gives each thread its own EventProcessor instance', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      mgr.saveThreadState(t1.id);
      const ep1 = mgr.eventProcessor;

      mgr.eventProcessor = createMockEventProcessor();
      mgr.saveThreadState(t2.id);

      mgr.loadThreadState(t1.id);
      const ep1Loaded = mgr.eventProcessor;

      mgr.loadThreadState(t2.id);
      const ep2Loaded = mgr.eventProcessor;

      expect(ep1Loaded).toBe(ep1);
      expect(ep1Loaded).not.toBe(ep2Loaded);
    });
  });

  // =========================================================================
  // loadThreadState for missing thread
  // =========================================================================

  describe('loadThreadState for missing thread', () => {
    it('initializes fresh state when no saved state exists', () => {
      mgr.messages = [{ type: 'user', content: 'stale', timestamp: 99 }];

      mgr.loadThreadState('nonexistent-id');

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
    it('stores event in the correct background thread', () => {
      const thread1 = threadStore.createThread('session_1');
      const thread2 = threadStore.createThread('session_2');

      const event = { id: 'evt_1', msg: { type: 'AgentMessage', data: {} } };
      mgr.handleEventForSession(event, 'session_1');

      const state1 = mgr.threadStates.get(thread1.id);
      const state2 = mgr.threadStates.get(thread2.id);

      expect(state1?.processedEvents).toHaveLength(1);
      expect(state2).toBeUndefined(); // Not touched
    });

    it('does not affect active UI state', () => {
      threadStore.createThread('session_bg');

      mgr.messages = [{ type: 'user', content: 'current', timestamp: 1 }];
      mgr.processedEvents = [];

      mgr.handleEventForSession(
        { id: 'evt_2', msg: { type: 'AgentMessage', data: {} } },
        'session_bg'
      );

      // Active UI is untouched
      expect(mgr.processedEvents).toHaveLength(0);
    });

    it('creates state on demand for a thread without prior state', () => {
      const thread = threadStore.createThread('session_new');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'AgentMessage', data: {} } },
        'session_new'
      );

      expect(mgr.threadStates.has(thread.id)).toBe(true);
      expect(mgr.threadStates.get(thread.id)?.processedEvents).toHaveLength(1);
    });

    it('ignores unknown sessionId', () => {
      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'AgentMessage', data: {} } },
        'unknown_session'
      );

      expect(mgr.threadStates.size).toBe(0);
    });

    it('sets isProcessing=true on TaskStarted', () => {
      const thread = threadStore.createThread('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );

      expect(mgr.threadStates.get(thread.id)?.isProcessing).toBe(true);
    });

    it('sets isProcessing=false on TaskComplete', () => {
      const thread = threadStore.createThread('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );
      mgr.handleEventForSession(
        { id: 'e2', msg: { type: 'TaskComplete', data: {} } },
        'session_x'
      );

      expect(mgr.threadStates.get(thread.id)?.isProcessing).toBe(false);
    });

    it('sets isProcessing=false on TaskFailed', () => {
      const thread = threadStore.createThread('session_x');

      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        'session_x'
      );
      mgr.handleEventForSession(
        { id: 'e2', msg: { type: 'TaskFailed', data: {} } },
        'session_x'
      );

      expect(mgr.threadStates.get(thread.id)?.isProcessing).toBe(false);
    });
  });

  // =========================================================================
  // switchToThread
  // =========================================================================

  describe('switchToThread', () => {
    it('saves old state and loads new state', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      // Put some state on t1
      threadStore.setActiveThread(t1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'thread1 msg', timestamp: 1 }];
      mgr.inputText = 'draft1';

      // Switch to t2
      mgr.switchToThread(t2.id);

      // t2 should have fresh state
      expect(mgr.messages).toEqual([]);
      expect(mgr.inputText).toBe('');
      expect(mgr.activeSessionId).toBe('s2');

      // Switch back to t1 — should restore saved state
      mgr.switchToThread(t1.id);

      expect(mgr.messages).toEqual([{ type: 'user', content: 'thread1 msg', timestamp: 1 }]);
      expect(mgr.inputText).toBe('draft1');
      expect(mgr.activeSessionId).toBe('s1');
    });

    it('updates activeSessionId', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      threadStore.setActiveThread(t1.id);
      mgr.switchToThread(t2.id);

      expect(mgr.activeSessionId).toBe('s2');
    });
  });

  // =========================================================================
  // Welcome screen condition
  // =========================================================================

  describe('welcome screen condition', () => {
    it('shows welcome when thread is empty and not processing', () => {
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
    it('two threads maintain independent message histories', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      // Start on t1
      threadStore.setActiveThread(t1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'msg_t1', timestamp: 1 }];
      mgr.saveThreadState(t1.id);

      // Switch to t2, add different messages
      mgr.switchToThread(t2.id);
      mgr.messages = [{ type: 'agent', content: 'msg_t2', timestamp: 2 }];
      mgr.saveThreadState(t2.id);

      // Load t1 — should see t1's messages
      mgr.loadThreadState(t1.id);
      expect(mgr.messages).toEqual([{ type: 'user', content: 'msg_t1', timestamp: 1 }]);

      // Load t2 — should see t2's messages
      mgr.loadThreadState(t2.id);
      expect(mgr.messages).toEqual([{ type: 'agent', content: 'msg_t2', timestamp: 2 }]);
    });

    it('processing state does not cross between threads', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      // Start processing on t1 via background event
      mgr.handleEventForSession(
        { id: 'e1', msg: { type: 'TaskStarted', data: {} } },
        's1'
      );

      // t1 should be processing
      expect(mgr.threadStates.get(t1.id)?.isProcessing).toBe(true);

      // t2 should NOT be processing (state doesn't even exist yet)
      expect(mgr.threadStates.get(t2.id)?.isProcessing).toBeUndefined();
    });

    it('background events accumulate correctly for each thread', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      // Send events to both threads in background
      mgr.handleEventForSession({ id: 'e1', msg: { type: 'AgentMessage', data: {} } }, 's1');
      mgr.handleEventForSession({ id: 'e2', msg: { type: 'AgentMessage', data: {} } }, 's1');
      mgr.handleEventForSession({ id: 'e3', msg: { type: 'AgentMessage', data: {} } }, 's2');

      expect(mgr.threadStates.get(t1.id)?.processedEvents).toHaveLength(2);
      expect(mgr.threadStates.get(t2.id)?.processedEvents).toHaveLength(1);
    });

    it('switching threads reveals accumulated background events', () => {
      const t1 = threadStore.createThread('s1');
      const t2 = threadStore.createThread('s2');

      // Simulate: active on t1, background events arrive for t2
      threadStore.setActiveThread(t1.id);
      mgr.activeSessionId = 's1';
      mgr.messages = [{ type: 'user', content: 'active thread', timestamp: 1 }];

      mgr.handleEventForSession({ id: 'bg1', msg: { type: 'AgentMessage', data: {} } }, 's2');
      mgr.handleEventForSession({ id: 'bg2', msg: { type: 'AgentMessage', data: {} } }, 's2');

      // Switch to t2
      mgr.switchToThread(t2.id);

      // Should see the 2 accumulated events
      expect(mgr.processedEvents).toHaveLength(2);
      expect(mgr.messages).toEqual([]);
    });
  });
});
