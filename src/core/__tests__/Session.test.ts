/**
 * Unit Tests: Session
 *
 * Comprehensive tests for the Session class covering:
 * - Constructor (old/new signatures, isPersistent, sessionId)
 * - initialize()
 * - addToHistory() / getConversationHistory() / clearHistory()
 * - export() / import()
 * - startTurn() / endTurn()
 * - requestInterrupt() / isInterruptRequested() / clearInterrupt()
 * - compact() / shouldCompact()
 * - spawnTask() / cancelTask (interruptTask / abortAllTasks)
 * - addTokenUsage()
 * - buildTurnInputWithHistory()
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { Session } from '@/core/Session';
import { SessionState } from '@/core/session/state/SessionState';
import { TurnContext } from '@/core/TurnContext';
import type { SessionServices } from '@/core/session/state/SessionServices';
import type { SessionTask } from '@/core/tasks/SessionTask';
import { TaskKind } from '@/core/session/state/types';
import type { BackgroundAgentTaskState } from '@/core/tasks/types';
import type { ResponseItem, InputItem } from '@/core/protocol/types';

// Mock RolloutRecorder so the constructor never touches disk
vi.mock('@/storage/rollout', () => ({
  RolloutRecorder: {
    create: vi.fn().mockResolvedValue({
      recordItems: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    }),
    getRolloutHistory: vi.fn().mockResolvedValue({
      type: 'resumed',
      payload: { history: [] },
    }),
  },
}));

// Mock uuid to produce deterministic IDs
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// Mock TitleGenerator so it never calls a real model
vi.mock('@/core/title', () => ({
  TitleGenerator: vi.fn().mockImplementation(() => ({
    countUserMessages: vi.fn().mockReturnValue(0),
    extractUserMessages: vi.fn().mockReturnValue([]),
    generateTitle: vi.fn().mockResolvedValue({ success: false }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ResponseItem message */
function makeMessage(role: string, text: string): ResponseItem {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  };
}

/** Build a minimal mock SessionServices (no rollout) */
function makeMockServices(overrides: Partial<SessionServices> = {}): SessionServices {
  return {
    rollout: null,
    notifier: {
      notify: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    showRawAgentReasoning: false,
    ...overrides,
  };
}

/** Build a mock SessionTask */
function makeMockTask(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    kind: vi.fn().mockReturnValue(TaskKind.Regular),
    run: vi.fn().mockResolvedValue('done'),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Build a mock TurnContext */
function makeMockTurnContext(): TurnContext {
  const mockModelClient = {
    getModel: vi.fn().mockReturnValue('test-model'),
    setModel: vi.fn(),
    getModelContextWindow: vi.fn().mockReturnValue(128000),
    getReasoningEffort: vi.fn().mockReturnValue(undefined),
    setReasoningEffort: vi.fn(),
    getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
    setReasoningSummary: vi.fn(),
    stream: vi.fn(),
  } as any;

  return new TurnContext(mockModelClient, {
    sessionId: 'test-session',
    approvalPolicy: 'on-request',
    sandboxPolicy: { mode: 'workspace-write' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session', () => {
  beforeEach(() => {
    uuidCounter = 0;
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('Constructor', () => {
    it('should generate a unique sessionId', () => {
      const session = new Session(undefined, false);
      expect(session.sessionId).toBe('test-uuid-1');
    });

    it('should accept old boolean-only signature for backward compatibility', () => {
      const session = new Session(false);
      // isPersistent should be false
      expect(session.sessionId).toBeTruthy();
    });

    it('should default isPersistent to true when no arguments', () => {
      // We can verify by checking that initializeSession is called (persistent path)
      // Just verify construction succeeds and sessionId is set
      const session = new Session();
      expect(session.sessionId).toBeTruthy();
    });

    it('should use provided sessionId for resumed mode', () => {
      const session = new Session(undefined, false, undefined, undefined, {
        mode: 'resumed',
        sessionId: 'my-custom-id',
        rolloutItems: [],
      });
      expect(session.sessionId).toBe('my-custom-id');
    });

    it('should generate new sessionId for new mode', () => {
      const session = new Session(undefined, false, undefined, undefined, {
        mode: 'new',
      });
      expect(session.sessionId).toBe('test-uuid-1');
    });

    it('should set tabId to -1 initially', () => {
      const session = new Session(undefined, false);
      expect(session.getTabId()).toBe(-1);
    });

    it('should store services when provided', () => {
      const services = makeMockServices();
      const session = new Session(undefined, false, services);
      expect(session.notifier()).toBe(services.notifier);
    });

    it('should report showRawAgentReasoning as false by default', () => {
      const session = new Session(undefined, false);
      expect(session.showRawAgentReasoning()).toBe(false);
    });

    it('should report showRawAgentReasoning from services', () => {
      const services = makeMockServices({ showRawAgentReasoning: true });
      const session = new Session(undefined, false, services);
      expect(session.showRawAgentReasoning()).toBe(true);
    });

    it('should start with an active turn (created in constructor)', () => {
      const session = new Session(undefined, false);
      expect(session.isActiveTurn()).toBe(true);
    });

    it('should start with empty conversation history', () => {
      const session = new Session(undefined, false);
      expect(session.getMessageCount()).toBe(0);
      expect(session.isEmpty()).toBe(true);
    });
  });

  // =========================================================================
  // initialize()
  // =========================================================================
  describe('initialize()', () => {
    it('should resolve without error on a non-persistent session', async () => {
      const session = new Session(undefined, false);
      await expect(session.initialize()).resolves.toBeUndefined();
    });

    it('should resolve without error when called multiple times', async () => {
      const session = new Session(undefined, false);
      await session.initialize();
      await expect(session.initialize()).resolves.toBeUndefined();
    });

    it('surfaces a non-persistent forked history init failure instead of swallowing it', async () => {
      // Regression: a forked sub-agent is told it inherited the parent
      // conversation. If reconstruct/persist fails it must NOT silently run
      // with empty history — initialize() has to reject so the runner reports it.
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const recordSpy = vi
        .spyOn(Session.prototype as any, 'recordInitialHistory')
        .mockRejectedValue(new Error('forked reconstruct failed'));

      try {
        const session = new Session(undefined, false, undefined, undefined, {
          mode: 'forked',
          sourceConversationId: 'parent-session',
          rolloutItems: [],
        });
        await expect(session.initialize()).rejects.toThrow('forked reconstruct failed');
        expect(consoleErr).toHaveBeenCalled();
      } finally {
        recordSpy.mockRestore();
        consoleErr.mockRestore();
      }
    });
  });

  // =========================================================================
  // addToHistory / getConversationHistory / clearHistory
  // =========================================================================
  describe('History management', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    describe('addToHistory()', () => {
      it('should add a user message to history', async () => {
        await session.addToHistory({ timestamp: 1000, text: 'Hello', type: 'user' });

        const history = session.getConversationHistory();
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
          type: 'message',
          role: 'user',
        });
      });

      it('should add an agent message to history', async () => {
        await session.addToHistory({ timestamp: 2000, text: 'Hi there', type: 'agent' });

        const history = session.getConversationHistory();
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
          type: 'message',
          role: 'assistant',
        });
      });

      it('should add a system message to history', async () => {
        await session.addToHistory({ timestamp: 3000, text: 'System init', type: 'system' });

        const history = session.getConversationHistory();
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
          type: 'message',
          role: 'system',
        });
      });

      it('should accumulate multiple messages in order', async () => {
        await session.addToHistory({ timestamp: 1, text: 'first', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'second', type: 'agent' });
        await session.addToHistory({ timestamp: 3, text: 'third', type: 'user' });

        const history = session.getConversationHistory();
        expect(history.items).toHaveLength(3);
        expect((history.items[0] as any).role).toBe('user');
        expect((history.items[1] as any).role).toBe('assistant');
        expect((history.items[2] as any).role).toBe('user');
      });
    });

    describe('getConversationHistory()', () => {
      it('should return empty history for new session', () => {
        const history = session.getConversationHistory();
        expect(history.items).toEqual([]);
      });

      it('should return a snapshot that does not mutate when history changes', async () => {
        await session.addToHistory({ timestamp: 1, text: 'before', type: 'user' });
        const snapshot = session.getConversationHistory();

        await session.addToHistory({ timestamp: 2, text: 'after', type: 'user' });

        // The earlier snapshot should still have only 1 item
        expect(snapshot.items).toHaveLength(1);
        expect(session.getConversationHistory().items).toHaveLength(2);
      });
    });

    describe('clearHistory()', () => {
      it('should remove all messages from history', async () => {
        await session.addToHistory({ timestamp: 1, text: 'message', type: 'user' });
        expect(session.getMessageCount()).toBe(1);

        session.clearHistory();
        expect(session.getMessageCount()).toBe(0);
        expect(session.isEmpty()).toBe(true);
      });

      it('should be safe to call on already empty history', () => {
        session.clearHistory();
        expect(session.getMessageCount()).toBe(0);
      });
    });

    describe('getMessageCount()', () => {
      it('should reflect the number of history items', async () => {
        expect(session.getMessageCount()).toBe(0);

        await session.addToHistory({ timestamp: 1, text: 'a', type: 'user' });
        expect(session.getMessageCount()).toBe(1);

        await session.addToHistory({ timestamp: 2, text: 'b', type: 'agent' });
        expect(session.getMessageCount()).toBe(2);
      });
    });

    describe('getLastMessage()', () => {
      it('should return undefined for empty history', () => {
        expect(session.getLastMessage()).toBeUndefined();
      });

      it('should return the most recent message', async () => {
        await session.addToHistory({ timestamp: 1, text: 'first', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'second', type: 'agent' });

        const last = session.getLastMessage();
        expect(last).toBeDefined();
        expect((last as any)!.role).toBe('assistant');
      });
    });

    describe('getHistoryEntry()', () => {
      it('should return undefined for positive offset', async () => {
        await session.addToHistory({ timestamp: 1, text: 'a', type: 'user' });
        expect(session.getHistoryEntry(0)).toBeUndefined();
        expect(session.getHistoryEntry(1)).toBeUndefined();
      });

      it('should return the last item for offset -1', async () => {
        await session.addToHistory({ timestamp: 1, text: 'first', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'second', type: 'agent' });

        const entry = session.getHistoryEntry(-1);
        expect(entry).toBeDefined();
        expect((entry as any)!.role).toBe('assistant');
      });

      it('should return the first item for offset equal to negative length', async () => {
        await session.addToHistory({ timestamp: 1, text: 'first', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'second', type: 'agent' });

        const entry = session.getHistoryEntry(-2);
        expect(entry).toBeDefined();
        expect((entry as any)!.role).toBe('user');
      });

      it('should return undefined when offset exceeds history length', async () => {
        await session.addToHistory({ timestamp: 1, text: 'only', type: 'user' });
        expect(session.getHistoryEntry(-2)).toBeUndefined();
      });
    });

    describe('getMessagesByType()', () => {
      it('should filter messages by role', async () => {
        await session.addToHistory({ timestamp: 1, text: 'u1', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'a1', type: 'agent' });
        await session.addToHistory({ timestamp: 3, text: 'u2', type: 'user' });
        await session.addToHistory({ timestamp: 4, text: 's1', type: 'system' });

        const userMsgs = session.getMessagesByType('user');
        expect(userMsgs).toHaveLength(2);

        const agentMsgs = session.getMessagesByType('agent');
        expect(agentMsgs).toHaveLength(1);

        const systemMsgs = session.getMessagesByType('system');
        expect(systemMsgs).toHaveLength(1);
      });

      it('should return empty array when no messages match', () => {
        expect(session.getMessagesByType('user')).toEqual([]);
      });
    });

    describe('searchMessages()', () => {
      it('should return items matching query (case-insensitive)', async () => {
        await session.addToHistory({ timestamp: 1, text: 'Hello World', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'Goodbye', type: 'agent' });

        const results = await session.searchMessages('hello');
        expect(results).toHaveLength(1);
      });

      it('should return empty array when nothing matches', async () => {
        await session.addToHistory({ timestamp: 1, text: 'foo', type: 'user' });
        const results = await session.searchMessages('zzz');
        expect(results).toEqual([]);
      });
    });
  });

  // =========================================================================
  // export() / import()
  // =========================================================================
  describe('export() / import()', () => {
    it('should export session with id, state, and metadata', async () => {
      const session = new Session(undefined, false);
      await session.addToHistory({ timestamp: 100, text: 'hi', type: 'user' });

      const exported = session.export();

      expect(exported.id).toBe(session.sessionId);
      expect(exported.state).toBeDefined();
      expect(exported.state.history).toBeDefined();
      expect(exported.state.history.items).toHaveLength(1);
      expect(exported.metadata).toBeDefined();
      expect(exported.metadata.messageCount).toBe(1);
      expect(typeof exported.metadata.lastAccessed).toBe('number');
    });

    it('should round-trip export/import preserving history', async () => {
      const session = new Session(undefined, false);
      await session.addToHistory({ timestamp: 1, text: 'question', type: 'user' });
      await session.addToHistory({ timestamp: 2, text: 'answer', type: 'agent' });

      const exported = session.export();
      const imported = Session.import(exported);

      const history = imported.getConversationHistory();
      expect(history.items).toHaveLength(2);
      expect((history.items[0] as any).role).toBe('user');
      expect((history.items[1] as any).role).toBe('assistant');
    });

    it('should preserve sessionId through import', async () => {
      const session = new Session(undefined, false);
      const originalId = session.sessionId;

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.sessionId).toBe(originalId);
    });

    it('should accept optional services and toolRegistry in import', () => {
      const session = new Session(undefined, false);
      const exported = session.export();
      const services = makeMockServices();

      const imported = Session.import(exported, services);
      expect(imported.notifier()).toBe(services.notifier);
    });

    it('should export approved commands', () => {
      const session = new Session(undefined, false);
      session.addApprovedCommand('ls');
      session.addApprovedCommand('cat');

      const exported = session.export();
      expect(exported.state.approvedCommands).toContain('ls');
      expect(exported.state.approvedCommands).toContain('cat');
    });

    it('should preserve approved commands through import', () => {
      const session = new Session(undefined, false);
      session.addApprovedCommand('git status');

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.isCommandApproved('git status')).toBe(true);
      expect(imported.isCommandApproved('rm -rf')).toBe(false);
    });
  });

  // =========================================================================
  // startTurn() / endTurn()
  // =========================================================================
  describe('startTurn() / endTurn()', () => {
    let session: Session;

    beforeEach(async () => {
      session = new Session(undefined, false);
      // The constructor creates an ActiveTurn, so end it first for a clean slate
      await session.endTurn();
    });

    it('should start a turn when none is active', async () => {
      // After endTurn in beforeEach, activeTurn is null but isActiveTurn checks null
      // Actually isActiveTurn() checks `this.activeTurn !== null` which will be false
      // after endTurn. But note: isActiveTurn returns true if activeTurn exists.
      expect(session.isActiveTurn()).toBe(false);

      await session.startTurn();
      expect(session.isActiveTurn()).toBe(true);
    });

    it('should throw if starting a turn while one is already active', async () => {
      await session.startTurn();
      await expect(session.startTurn()).rejects.toThrow('Cannot start turn: turn already active');
    });

    it('should end an active turn', async () => {
      await session.startTurn();
      expect(session.isActiveTurn()).toBe(true);

      await session.endTurn();
      expect(session.isActiveTurn()).toBe(false);
    });

    it('should not throw when ending turn with no active turn', async () => {
      // No active turn after beforeEach endTurn
      await expect(session.endTurn()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // requestInterrupt / isInterruptRequested / clearInterrupt
  // =========================================================================
  describe('Interrupt handling', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should not be interrupted initially', () => {
      expect(session.isInterruptRequested()).toBe(false);
    });

    it('should flag interrupt when requested', () => {
      session.requestInterrupt();
      expect(session.isInterruptRequested()).toBe(true);
    });

    it('should clear interrupt flag', () => {
      session.requestInterrupt();
      session.clearInterrupt();
      expect(session.isInterruptRequested()).toBe(false);
    });

    it('should handle multiple requestInterrupt calls idempotently', () => {
      session.requestInterrupt();
      session.requestInterrupt();
      expect(session.isInterruptRequested()).toBe(true);

      session.clearInterrupt();
      expect(session.isInterruptRequested()).toBe(false);
    });
  });

  // =========================================================================
  // compact() / shouldCompact()
  // =========================================================================
  describe('compact() / shouldCompact()', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    describe('compact()', () => {
      it('should return failure result when no modelClient is provided', async () => {
        const result = await session.compact('manual');
        expect(result.success).toBe(false);
        expect(result.error).toContain('No modelClient');
      });

      it('should return failure result when modelClient is undefined', async () => {
        const result = await session.compact('auto', undefined);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No modelClient');
      });

      it('should delegate to CompactService when modelClient is provided', async () => {
        // Add some history so there is something to compact
        await session.addToHistory({ timestamp: 1, text: 'question', type: 'user' });
        await session.addToHistory({ timestamp: 2, text: 'answer', type: 'agent' });

        const mockModelClient = {
          stream: vi.fn().mockResolvedValue({
            async *[Symbol.asyncIterator]() {
              yield { type: 'output_text_delta', delta: 'Summary text' };
              yield { type: 'response.completed', response: {} };
            },
          }),
          getModel: vi.fn().mockReturnValue('test-model'),
          setModel: vi.fn(),
          getReasoningEffort: vi.fn(),
          setReasoningEffort: vi.fn(),
          getReasoningSummary: vi.fn(),
          setReasoningSummary: vi.fn(),
        } as any;

        const result = await session.compact('manual', mockModelClient);
        // Whether success or failure, it should have the right trigger reason
        expect(result.triggerReason).toBe('manual');
        expect(typeof result.tokensBefore).toBe('number');
        expect(typeof result.tokensAfter).toBe('number');
      });

      it('should include trigger reason in result', async () => {
        const result = await session.compact('auto');
        expect(result.triggerReason).toBe('auto');
      });
    });

    describe('shouldCompact()', () => {
      it('should return false when no tokens have been used', () => {
        expect(session.shouldCompact(128000)).toBe(false);
      });

      it('should return false for zero context window', () => {
        session.addTokenUsage(100000);
        expect(session.shouldCompact(0)).toBe(false);
      });

      it('should return false for negative context window', () => {
        session.addTokenUsage(100000);
        expect(session.shouldCompact(-1)).toBe(false);
      });

      it('should return true when tokens exceed threshold', () => {
        // Default trigger threshold is 0.9 (90% of context window)
        // So for a 100-token context window, threshold is 90 tokens
        session.addTokenUsage(95);
        expect(session.shouldCompact(100)).toBe(true);
      });

      it('should return false when tokens are below threshold', () => {
        // 79 tokens is below the default 80% threshold for a 100-token window.
        session.addTokenUsage(79);
        expect(session.shouldCompact(100)).toBe(false);
      });
    });

    describe('getCompactionCount()', () => {
      it('should start at 0', () => {
        expect(session.getCompactionCount()).toBe(0);
      });
    });
  });

  // =========================================================================
  // spawnTask() / cancelTask (interruptTask / abortAllTasks)
  // =========================================================================
  describe('spawnTask() / task lifecycle', () => {
    let session: Session;
    let turnContext: TurnContext;

    beforeEach(async () => {
      session = new Session(undefined, false);
      turnContext = makeMockTurnContext();
    });

    it('should spawn a task and register it in activeTurn', async () => {
      // Task must not resolve immediately so it remains registered
      const task = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      });

      await session.spawnTask(task, turnContext, 'sub-1', []);

      expect(session.hasRunningTask('sub-1')).toBe(true);
    });

    it('should abort existing tasks before spawning new one', async () => {
      const task1 = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      });
      const task2 = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      });

      await session.spawnTask(task1, turnContext, 'sub-1', []);
      await session.spawnTask(task2, turnContext, 'sub-2', []);

      // sub-1 should have been aborted (replaced by sub-2's ActiveTurn)
      expect(session.hasRunningTask('sub-1')).toBe(false);
      expect(session.hasRunningTask('sub-2')).toBe(true);
    });

    it('should call task.kind() to determine task kind', async () => {
      const task = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      await session.spawnTask(task, turnContext, 'sub-1', []);
      expect(task.kind).toHaveBeenCalled();
    });

    it('interruptTask aborts the foreground task (Track 04)', async () => {
      const task = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      });

      await session.spawnTask(task, turnContext, 'sub-1', []);
      expect(session.hasRunningTask('sub-1')).toBe(true);

      // Track 04: interruptTask narrows to foreground-only. The spawn above
      // has no `background: true`, so it IS the foreground task — should be
      // killed.
      await session.interruptTask();
      expect(session.hasRunningTask('sub-1')).toBe(false);
    });

    // ─────────────────────────────────────────────────────────────────
    // Track 04: concurrency seam — background tasks survive foreground
    // ─────────────────────────────────────────────────────────────────

    it('foreground spawn does NOT abort background tasks (Track 04 concurrency seam)', async () => {
      const bg = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const fg1 = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const fg2 = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      // Spawn background first.
      await session.spawnTask(bg, turnContext, 'bg-1', [], { background: true });
      expect(session.hasRunningTask('bg-1')).toBe(true);
      expect(bg.abort).not.toHaveBeenCalled();

      // Spawn first foreground.
      await session.spawnTask(fg1, turnContext, 'fg-1', []);
      expect(session.getForegroundTaskId()).toBe('fg-1');

      // Spawn second foreground — replaces fg1 but MUST NOT touch bg-1.
      await session.spawnTask(fg2, turnContext, 'fg-2', []);
      expect(session.getForegroundTaskId()).toBe('fg-2');
      expect(fg1.abort).toHaveBeenCalled();   // prior foreground killed
      expect(bg.abort).not.toHaveBeenCalled(); // background SURVIVES
      expect(session.getTask('bg-1')).toBeDefined();
    });

    it('interruptTask kills foreground only, leaves background tasks running', async () => {
      const bg = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const fg = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      await session.spawnTask(bg, turnContext, 'bg-1', [], { background: true });
      await session.spawnTask(fg, turnContext, 'fg-1', []);

      await session.interruptTask();

      expect(fg.abort).toHaveBeenCalled();
      expect(bg.abort).not.toHaveBeenCalled();
      expect(session.getForegroundTaskId()).toBeNull();
    });

    it('abortTask(id) isolates — aborting one background leaves siblings running', async () => {
      const a = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      const b = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      const c = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });

      await session.spawnTask(a, turnContext, 'bg-a', [], { background: true });
      await session.spawnTask(b, turnContext, 'bg-b', [], { background: true });
      await session.spawnTask(c, turnContext, 'bg-c', [], { background: true });

      await session.abortTask('bg-b', 'UserInterrupt');

      expect(b.abort).toHaveBeenCalled();
      expect(a.abort).not.toHaveBeenCalled();
      expect(c.abort).not.toHaveBeenCalled();
      // bg-b removed; bg-a and bg-c still tracked.
      expect(session.getTask('bg-b')).toBeUndefined();
      expect(session.getTask('bg-a')).toBeDefined();
      expect(session.getTask('bg-c')).toBeDefined();
    });

    it('abortTasksForTab aborts only tasks scoped to the closed tab', async () => {
      const onTab42 = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      const onTab99 = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      const unscoped = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });

      await session.spawnTask(onTab42, turnContext, 't42', [], {
        background: true,
        scopedTabIds: [42],
      });
      await session.spawnTask(onTab99, turnContext, 't99', [], {
        background: true,
        scopedTabIds: [99],
      });
      await session.spawnTask(unscoped, turnContext, 'tn', [], { background: true });

      await session.abortTasksForTab(42, 'TabClosed');

      expect(onTab42.abort).toHaveBeenCalled();
      expect(onTab99.abort).not.toHaveBeenCalled();
      expect(unscoped.abort).not.toHaveBeenCalled();
    });

    it('listActiveTasks + listTaskStates project correctly', async () => {
      const fg = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      await session.spawnTask(fg, turnContext, 'fg-1', []);

      expect(session.listActiveTasks()).toHaveLength(1);
      // Foreground spawn doesn't get a taskState attached (SubAgentRunner is
      // the only registerTaskState caller in production). So listTaskStates
      // is empty for a foreground-only setup.
      expect(session.listTaskStates()).toHaveLength(0);
    });

    it('abortAllTasks should call abort on each task', async () => {
      const task = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      });

      await session.spawnTask(task, turnContext, 'sub-1', []);
      await session.abortAllTasks('UserInterrupt');

      expect(task.abort).toHaveBeenCalled();
    });

    it('fires TaskCompleted exactly once for successful, failed, and aborted tasks', async () => {
      const fire = vi.fn().mockResolvedValue({ shouldContinue: true });
      session.setHookDispatcher({ fire } as any);

      await session.spawnTask(makeMockTask({ run: vi.fn().mockResolvedValue('done') }), turnContext, 'ok', []);
      await new Promise(resolve => setTimeout(resolve, 10));

      await session.spawnTask(makeMockTask({ run: vi.fn().mockRejectedValue(new Error('boom')) }), turnContext, 'fail', []);
      await new Promise(resolve => setTimeout(resolve, 10));

      const aborting = makeMockTask({ run: vi.fn().mockImplementation(() => new Promise(() => {})) });
      await session.spawnTask(aborting, turnContext, 'abort', []);
      await session.abortTask('abort', 'UserInterrupt');
      await new Promise(resolve => setTimeout(resolve, 10));

      const completed = fire.mock.calls
        .filter(([event]) => event === 'TaskCompleted')
        .map(([, input]) => input.task_id);
      expect(completed).toEqual(['ok', 'fail', 'abort']);
    });

    it('fires Stop on accepted abort and a throwing hook cannot veto the abort', async () => {
      const fire = vi.fn(async (event: string) => {
        if (event === 'Stop') throw new Error('stop hook failed');
        return { shouldContinue: true };
      });
      session.setHookDispatcher({ fire } as any);
      const task = makeMockTask({
        run: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      await session.spawnTask(task, turnContext, 'stoppable', []);
      await session.abortTask('stoppable', 'UserInterrupt');

      expect(task.abort).toHaveBeenCalled();
      expect(session.hasRunningTask('stoppable')).toBe(false);
      expect(fire).toHaveBeenCalledWith(
        'Stop',
        expect.objectContaining({
          hook_event_name: 'Stop',
          session_id: session.sessionId,
          task_id: 'stoppable',
          stop_reason: 'UserInterrupt',
          is_background: false,
        }),
        expect.objectContaining({ timeoutOverride: 1 }),
      );
    });

    it('shutdown aborts active typed tasks and clears the eviction timer', async () => {
      vi.useFakeTimers();
      try {
        const task = makeMockTask({
          run: vi.fn().mockImplementation(() => new Promise(() => {})),
        });
        const context: any = { cancelled: false };

        await session.spawnTask(task, turnContext, 'bg-shutdown', [], { background: true });
        const taskState: BackgroundAgentTaskState = {
          id: 'bg-shutdown',
          type: 'background_agent',
          status: 'running',
          description: 'shutdown test',
          startTime: Date.now(),
          outputOffset: 0,
          notified: false,
          isBackgrounded: true,
          retain: false,
          runId: 'bg-shutdown',
          parentSessionId: 'test-session',
          prompt: 'test',
          toolUseCount: 0,
          tokenUsage: { input: 0, output: 0, total: 0 },
        };
        session.registerTaskState(taskState, { context });

        (session as any).ensureEvictionTimer();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await session.shutdown();

        expect(task.abort).toHaveBeenCalled();
        expect(context.cancelled).toBe(true);
        expect(session.getTask('bg-shutdown')).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clean up task from activeTurn after task completes', async () => {
      // Task resolves immediately, so onTaskFinished runs and removes it
      const task = makeMockTask({
        run: vi.fn().mockResolvedValue('done'),
      });

      await session.spawnTask(task, turnContext, 'sub-1', []);

      // Allow microtask queue to flush (task promise resolves)
      await new Promise(resolve => setTimeout(resolve, 10));

      // Task should have been removed after completion
      expect(session.hasRunningTask('sub-1')).toBe(false);
    });

    it('getRunningTasks should return empty map when no turn is active', async () => {
      session = new Session(undefined, false);
      await session.endTurn();

      const tasks = session.getRunningTasks();
      expect(tasks.size).toBe(0);
    });
  });

  // =========================================================================
  // addTokenUsage()
  // =========================================================================
  describe('addTokenUsage()', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should track token usage when no prior usage exists', () => {
      session.addTokenUsage(100);

      const info = session.getTokenUsageInfo();
      expect(info).toBeDefined();
      expect(info!.total_tokens).toBe(100);
    });

    it('should accumulate token usage across multiple calls', () => {
      session.addTokenUsage(100);
      session.addTokenUsage(50);
      session.addTokenUsage(25);

      const info = session.getTokenUsageInfo();
      expect(info!.total_tokens).toBe(175);
    });

    it('should return undefined token info before any usage is tracked', () => {
      expect(session.getTokenUsageInfo()).toBeUndefined();
    });
  });

  // =========================================================================
  // buildTurnInputWithHistory()
  // =========================================================================
  describe('buildTurnInputWithHistory()', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should return only new items when history is empty', async () => {
      const newItems = [makeMessage('user', 'hello')];
      const result = await session.buildTurnInputWithHistory(newItems);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: 'message', role: 'user' });
    });

    it('should prepend history before new items', async () => {
      await session.addToHistory({ timestamp: 1, text: 'old message', type: 'user' });

      const newItems = [makeMessage('user', 'new message')];
      const result = await session.buildTurnInputWithHistory(newItems);

      expect(result).toHaveLength(2);
      // First item is from history
      expect(result[0].role).toBe('user');
      // Second item is the new item
      expect(result[1]).toMatchObject({ type: 'message', role: 'user' });
    });

    it('should include full history in correct order', async () => {
      await session.addToHistory({ timestamp: 1, text: 'q1', type: 'user' });
      await session.addToHistory({ timestamp: 2, text: 'a1', type: 'agent' });
      await session.addToHistory({ timestamp: 3, text: 'q2', type: 'user' });

      const newItems = [makeMessage('assistant', 'a2')];
      const result = await session.buildTurnInputWithHistory(newItems);

      expect(result).toHaveLength(4);
      expect((result[0] as any).role).toBe('user');
      expect((result[1] as any).role).toBe('assistant');
      expect(result[2].role).toBe('user');
      expect(result[3].role).toBe('assistant');
    });

    it('should return empty array when both history and new items are empty', async () => {
      const result = await session.buildTurnInputWithHistory([]);
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // turnInputWithHistory()
  // =========================================================================
  describe('turnInputWithHistory()', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should combine history with extra response items', async () => {
      await session.addToHistory({ timestamp: 1, text: 'base', type: 'user' });

      const extra: ResponseItem[] = [makeMessage('assistant', 'extra')];
      const result = await session.turnInputWithHistory(extra);

      expect(result).toHaveLength(2);
      expect((result[0] as any).role).toBe('user');
      expect((result[1] as any).role).toBe('assistant');
    });
  });

  // =========================================================================
  // Tab ID management
  // =========================================================================
  describe('Tab ID management', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should start with tabId -1', () => {
      expect(session.getTabId()).toBe(-1);
    });

    it('should update tabId via setTabId', () => {
      session.setTabId(42);
      expect(session.getTabId()).toBe(42);
    });

    it('should allow resetting tabId to -1', () => {
      session.setTabId(10);
      session.setTabId(-1);
      expect(session.getTabId()).toBe(-1);
    });
  });

  // =========================================================================
  // Approved commands
  // =========================================================================
  describe('Approved commands', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should not have any commands approved initially', () => {
      expect(session.isCommandApproved('ls')).toBe(false);
    });

    it('should approve commands', () => {
      session.addApprovedCommand('git status');
      expect(session.isCommandApproved('git status')).toBe(true);
    });

    it('should not confuse different commands', () => {
      session.addApprovedCommand('ls');
      expect(session.isCommandApproved('ls')).toBe(true);
      expect(session.isCommandApproved('rm')).toBe(false);
    });
  });

  // =========================================================================
  // Event emitter
  // =========================================================================
  describe('Event emitter', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should emit events when emitter is set', async () => {
      const emitter = vi.fn().mockResolvedValue(undefined);
      session.setEventEmitter(emitter);

      await session.emitEvent({ id: 'e1', msg: { type: 'BackgroundEvent', data: { message: 'test' } } });

      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'e1' }),
      );
    });

    it('should not throw when emitting without emitter set', async () => {
      // Should just warn, not throw
      await expect(
        session.emitEvent({ id: 'e1', msg: { type: 'BackgroundEvent', data: { message: 'test' } } }),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Session ID accessors
  // =========================================================================
  describe('Session ID accessors', () => {
    it('getSessionId() should return sessionId', () => {
      const session = new Session(undefined, false);
      expect(session.getSessionId()).toBe(session.sessionId);
    });

    it('getId() should return sessionId', () => {
      const session = new Session(undefined, false);
      expect(session.getId()).toBe(session.sessionId);
    });
  });

  // =========================================================================
  // TurnContext management
  // =========================================================================
  describe('TurnContext management', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should have a default TurnContext after construction', () => {
      const tc = session.getTurnContext();
      expect(tc).toBeDefined();
      expect(tc).toBeInstanceOf(TurnContext);
    });

    it('should allow replacing the TurnContext', () => {
      const newContext = makeMockTurnContext();
      session.setTurnContext(newContext);

      expect(session.getTurnContext()).toBe(newContext);
    });

    it('setTurnContext should align the context sessionId to sessionId', () => {
      const newContext = makeMockTurnContext();
      // The mock context has sessionId 'test-session', which differs from the session's sessionId
      session.setTurnContext(newContext);

      expect(newContext.getSessionId()).toBe(session.sessionId);
    });

    it('should allow updating turn context', () => {
      const tc = session.getTurnContext();
      session.updateTurnContext({ baseInstructions: 'custom instructions' });
      expect(tc.getBaseInstructions()).toBe('custom instructions');
    });
  });

  // =========================================================================
  // Pending input management
  // =========================================================================
  describe('Pending input', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should add and take pending input', () => {
      const items: InputItem[] = [{ type: 'text', text: 'pending msg' }];
      session.addPendingInput(items);

      const current = session.getCurrentTurnItems();
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ type: 'text', text: 'pending msg' });
    });

    it('should clear current turn items', () => {
      session.addPendingInput([{ type: 'text', text: 'to clear' }]);
      session.clearCurrentTurn();

      const current = session.getCurrentTurnItems();
      expect(current).toHaveLength(0);
    });

    it('should set current turn items', () => {
      const items: InputItem[] = [
        { type: 'text', text: 'item1' },
        { type: 'text', text: 'item2' },
      ];
      session.setCurrentTurnItems(items);

      const current = session.getCurrentTurnItems();
      expect(current).toHaveLength(2);
    });
  });

  // =========================================================================
  // Tool usage and errors
  // =========================================================================
  describe('Tool usage tracking', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should track tool usage counts', () => {
      session.trackToolUsage('read_file');
      session.trackToolUsage('read_file');
      session.trackToolUsage('exec_command');

      // We cannot directly access toolUsageStats (private), but the calls should not throw
      expect(() => session.trackToolUsage('any_tool')).not.toThrow();
    });
  });

  describe('Error tracking', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should add errors without throwing', () => {
      expect(() => session.addError('Something went wrong')).not.toThrow();
      expect(() => session.addError('Another error', { detail: 'context' })).not.toThrow();
    });
  });

  // =========================================================================
  // isEmpty()
  // =========================================================================
  describe('isEmpty()', () => {
    it('should return true for new session', () => {
      const session = new Session(undefined, false);
      expect(session.isEmpty()).toBe(true);
    });

    it('should return false after adding a message', async () => {
      const session = new Session(undefined, false);
      await session.addToHistory({ timestamp: 1, text: 'msg', type: 'user' });
      expect(session.isEmpty()).toBe(false);
    });

    it('should return true after clearing history', async () => {
      const session = new Session(undefined, false);
      await session.addToHistory({ timestamp: 1, text: 'msg', type: 'user' });
      session.clearHistory();
      expect(session.isEmpty()).toBe(true);
    });
  });

  // =========================================================================
  // Defaults
  // =========================================================================
  describe('Default accessors', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('getDefaultModel should return a string', () => {
      expect(typeof session.getDefaultModel()).toBe('string');
    });

    it('getDefaultCwd should return a string', () => {
      expect(typeof session.getDefaultCwd()).toBe('string');
    });

    it('isStorageEnabled should return a boolean', () => {
      expect(typeof session.isStorageEnabled()).toBe('boolean');
    });
  });

  // =========================================================================
  // nextInternalSubId
  // =========================================================================
  describe('nextInternalSubId()', () => {
    it('should return auto-compact prefixed IDs', () => {
      const session = new Session(undefined, false);
      expect(session.nextInternalSubId()).toBe('auto-compact-0');
      expect(session.nextInternalSubId()).toBe('auto-compact-1');
      expect(session.nextInternalSubId()).toBe('auto-compact-2');
    });

    it('should increment independently per session', () => {
      const session1 = new Session(undefined, false);
      const session2 = new Session(undefined, false);

      expect(session1.nextInternalSubId()).toBe('auto-compact-0');
      expect(session2.nextInternalSubId()).toBe('auto-compact-0');
      expect(session1.nextInternalSubId()).toBe('auto-compact-1');
    });
  });

  // =========================================================================
  // buildInitialContext
  // =========================================================================
  describe('buildInitialContext()', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(undefined, false);
    });

    it('should return system message with tab context', () => {
      const context = session.buildInitialContext({ tabId: 5 });
      expect(context).toHaveLength(1);
      expect(context[0].role).toBe('system');
      expect(context[0].content[0].text).toContain('Tab ID: 5');
    });

    it('should indicate no tab bound when tabId is -1', () => {
      const context = session.buildInitialContext({ tabId: -1 });
      expect(context[0].content[0].text).toContain('No tab bound');
    });

    it('should default to no tab bound when no context provided', () => {
      const context = session.buildInitialContext();
      expect(context[0].content[0].text).toContain('No tab bound');
    });
  });

  // =========================================================================
  // Tool registry
  // =========================================================================
  describe('Tool registry', () => {
    it('should return null when no registry is set', () => {
      const session = new Session(undefined, false);
      expect(session.getToolRegistry()).toBeNull();
    });

    it('should store and return tool registry', () => {
      const session = new Session(undefined, false);
      const mockRegistry = { getTool: vi.fn() } as any;

      session.setToolRegistry(mockRegistry);
      expect(session.getToolRegistry()).toBe(mockRegistry);
    });

    it('should accept toolRegistry in constructor', () => {
      const mockRegistry = { getTool: vi.fn() } as any;
      const session = new Session(undefined, false, undefined, mockRegistry);
      expect(session.getToolRegistry()).toBe(mockRegistry);
    });
  });

  // =========================================================================
  // injectInput
  // =========================================================================
  describe('injectInput()', () => {
    it('should succeed when active turn exists', async () => {
      const session = new Session(undefined, false);
      const items: InputItem[] = [{ type: 'text', text: 'injected' }];

      const result = await session.injectInput(items);
      expect(result.success).toBe(true);
      expect(result.returned).toBeUndefined();
    });

    it('should return input when no active turn exists', async () => {
      const session = new Session(undefined, false);
      await session.endTurn();

      const items: InputItem[] = [{ type: 'text', text: 'injected' }];
      const result = await session.injectInput(items);

      expect(result.success).toBe(false);
      expect(result.returned).toEqual(items);
    });
  });

  // =========================================================================
  // recordConversationItemsDual
  // =========================================================================
  describe('recordConversationItemsDual()', () => {
    it('should record items to in-memory history', async () => {
      const session = new Session(undefined, false);
      const items: ResponseItem[] = [makeMessage('user', 'test')];

      await session.recordConversationItemsDual(items);

      expect(session.getMessageCount()).toBe(1);
    });

    it('should accumulate items across multiple calls', async () => {
      const session = new Session(undefined, false);

      await session.recordConversationItemsDual([makeMessage('user', 'q1')]);
      await session.recordConversationItemsDual([makeMessage('assistant', 'a1')]);

      expect(session.getMessageCount()).toBe(2);
    });
  });

  describe('Track 12: recordRateLimits wiring', () => {
    it('stores the snapshot and emits a populated TokenCount (no longer inert)', async () => {
      const session = new Session(undefined, false);
      const events: any[] = [];
      session.setEventEmitter(async (e) => {
        events.push(e);
      });

      await session.recordRateLimits({
        primary: { used_percent: 40, window_minutes: 300 },
      });

      const tokenCount = events.find((e) => e.msg.type === 'TokenCount');
      expect(tokenCount).toBeDefined();
      // Previously this was always undefined (the dead-data bug).
      expect(tokenCount.msg.data.rate_limits).toEqual({
        primary_used_percent: 40,
        secondary_used_percent: 0,
        primary_to_secondary_ratio_percent: 0,
        primary_window_minutes: 300,
        secondary_window_minutes: 0,
      });
    });

    it('emits token warning state from the canonical auto-compact threshold', async () => {
      const session = new Session(undefined, false);
      const events: any[] = [];
      session.setEventEmitter(async (e) => {
        events.push(e);
      });
      session.setTurnContext({
        getSessionId: () => session.sessionId,
        update: vi.fn(),
        getModelContextWindow: () => 100000,
        getAutoCompactTokenLimit: () => 80000,
      } as any);
      session.addTokenUsage(85000);

      await session.sendTokenCountEvent('sub-1');

      const tokenCount = events.find((e) => e.msg.type === 'TokenCount');
      expect(tokenCount.msg.data.info.total_token_usage.total_tokens).toBe(85000);
      expect(tokenCount.msg.data.info.auto_compact_token_limit).toBe(80000);
      expect(tokenCount.msg.data.token_warning_state).toMatchObject({
        current_tokens: 85000,
        context_window: 100000,
        auto_compact_token_limit: 80000,
        is_above_auto_compact_threshold: true,
      });
    });

    it('emits RateLimitWarning on a fast-burn snapshot', async () => {
      const session = new Session(undefined, false);
      const events: any[] = [];
      session.setEventEmitter(async (e) => {
        events.push(e);
      });

      // 92% used but only ~28% of the window elapsed → burning too fast.
      await session.recordRateLimits({
        primary: {
          used_percent: 92,
          window_minutes: 300,
          resets_in_seconds: 215 * 60,
        },
      });

      const warning = events.find((e) => e.msg.type === 'RateLimitWarning');
      expect(warning).toBeDefined();
      expect(warning.msg.data.window).toBe('primary');
      expect(warning.msg.data.used_percent).toBe(92);
    });

    it('does not emit RateLimitWarning when usage is sustainable', async () => {
      const session = new Session(undefined, false);
      const events: any[] = [];
      session.setEventEmitter(async (e) => {
        events.push(e);
      });

      await session.recordRateLimits({
        primary: { used_percent: 20, window_minutes: 300, resets_in_seconds: 60 },
      });

      expect(events.find((e) => e.msg.type === 'RateLimitWarning')).toBeUndefined();
      expect(events.find((e) => e.msg.type === 'TokenCount')).toBeDefined();
    });
  });
});
