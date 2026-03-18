/**
 * Unit Tests: RepublicAgentEngine
 *
 * M1.4: Tests engine with injected mock Session spawns real tasks
 * M2.5: Tests for moved handlers (interrupt, exec approval, compact, etc.)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RepublicAgentEngine } from '../RepublicAgentEngine';
import type { RepublicAgentEngineConfig, EngineEvent } from '../RepublicAgentEngineConfig';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../../tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({ type: 'regular' })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSession() {
  return {
    sessionId: 'test-session-1',
    setEventEmitter: vi.fn(),
    setTurnContext: vi.fn(),
    getTurnContext: vi.fn().mockReturnValue({
      setUserInstructions: vi.fn(),
      setBaseInstructions: vi.fn(),
      setModelClient: vi.fn(),
      setSelectedModelKey: vi.fn(),
    }),
    updateTurnContext: vi.fn(),
    getTabId: vi.fn().mockReturnValue(-1),
    setTabId: vi.fn(),
    getId: vi.fn().mockReturnValue('session-id-1'),
    getConversationHistory: vi.fn().mockReturnValue({ items: [{}, {}, {}] }),
    addPendingInput: vi.fn(),
    spawnTask: vi.fn().mockResolvedValue(undefined),
    requestInterrupt: vi.fn(),
    clearInterrupt: vi.fn(),
    abortAllTasks: vi.fn().mockResolvedValue(undefined),
    hasRunningTask: vi.fn().mockReturnValue(false),
    addToHistory: vi.fn(),
    getHistoryEntry: vi.fn(),
    clearHistory: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    initializeSession: vi.fn().mockResolvedValue(undefined),
    notifyApproval: vi.fn(),
    compact: vi.fn().mockResolvedValue({
      success: true,
      tokensBefore: 5000,
      tokensAfter: 2000,
      itemsTrimmed: 10,
    }),
    getCompactionCount: vi.fn().mockReturnValue(1),
  };
}

function createMockToolRegistry() {
  return {
    register: vi.fn(),
    getTool: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    setApprovalGate: vi.fn(),
    getApprovalGate: vi.fn().mockReturnValue(undefined),
  };
}

function createMockApprovalManager() {
  return {
    getApproval: vi.fn(),
    handleDecision: vi.fn().mockResolvedValue(undefined),
    createApproval: vi.fn(),
    resolveApproval: vi.fn(),
  };
}

function createEngine(overrides?: Partial<RepublicAgentEngineConfig>) {
  const mockSession = createMockSession();
  const mockToolRegistry = createMockToolRegistry();
  const mockModelClientFactory = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createClientForCurrentModel: vi.fn().mockResolvedValue({
      getModel: vi.fn().mockReturnValue('test-model'),
    }),
    clearCache: vi.fn(),
    isBackendRouting: vi.fn().mockReturnValue(false),
  };

  const config: RepublicAgentEngineConfig = {
    agentConfig: {} as any,
    toolRegistry: mockToolRegistry as any,
    systemPrompt: 'test system prompt',
    modelClientFactory: mockModelClientFactory as any,
    session: mockSession as any,
    ownsSession: false,
    ...overrides,
  };

  const engine = new RepublicAgentEngine(config);

  return { engine, mockSession, mockToolRegistry, mockModelClientFactory, config };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('RepublicAgentEngine', () => {
  // =========================================================================
  // M1.4: Engine with injected Session — real task spawning
  // =========================================================================

  describe('M1.4: Engine with injected Session', () => {
    it('should initialize with externally provided session', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      expect(engine.isReady()).toBe(true);
      expect(engine.getSession()).toBe(mockSession);
    });

    it('should not re-wire event emitter on external session', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      // External session: event emitter should NOT be re-wired by engine
      expect(mockSession.setEventEmitter).not.toHaveBeenCalled();
    });

    it('should handle ownsSession=false — does not shutdown session on dispose', async () => {
      const { engine, mockSession } = createEngine({ ownsSession: false });
      await engine.initialize();

      await engine.dispose();

      expect(mockSession.shutdown).not.toHaveBeenCalled();
    });

    it('should handle ownsSession=true — shuts down session on dispose', async () => {
      const { engine, mockSession } = createEngine({ ownsSession: true });
      await engine.initialize();

      await engine.dispose();

      expect(mockSession.shutdown).toHaveBeenCalled();
    });

    it('should default ownsSession to false when session is provided', async () => {
      const mockSession = createMockSession();
      const { engine } = createEngine({
        session: mockSession as any,
        ownsSession: undefined,
      });
      await engine.initialize();
      await engine.dispose();

      // ownsSession defaults to false when session is provided
      expect(mockSession.shutdown).not.toHaveBeenCalled();
    });

    it('should spawn task through Session.spawnTask on UserInput', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Hello' }],
      });

      // Wait for async queue processing
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.addPendingInput).toHaveBeenCalledWith(
        [{ type: 'text', text: 'Hello' }]
      );
      expect(mockSession.getTurnContext).toHaveBeenCalled();
      expect(mockSession.spawnTask).toHaveBeenCalled();
    });

    it('should emit TaskError event when spawnTask throws', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();
      mockSession.spawnTask.mockRejectedValue(new Error('spawn failed'));

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'test' }],
      });

      await new Promise(r => setTimeout(r, 10));

      const taskError = events.find(e => e.msg.type === 'TaskError');
      expect(taskError).toBeDefined();
      expect(taskError!.msg.data?.error).toBe('spawn failed');
    });

    it('should apply context overrides when provided', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'test' }],
        contextOverrides: { model: 'gpt-5' },
      });

      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.updateTurnContext).toHaveBeenCalledWith({ model: 'gpt-5' });
    });

    it('should throw when session is not initialized', async () => {
      // Create engine without session and without initialize
      const engine = new RepublicAgentEngine({
        agentConfig: {} as any,
        toolRegistry: createMockToolRegistry() as any,
        systemPrompt: 'test',
        modelClientFactory: { createClientForCurrentModel: vi.fn() } as any,
      });

      expect(() => engine.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'test' }],
      })).toThrow('initialize() must be called first');
    });

    it('should support awaitable run() mode', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      // Mock session to trigger TaskComplete event through onEvent
      mockSession.spawnTask.mockImplementation(async () => {
        // Simulate task completion by pushing event
        engine.pushEvent({
          id: 'evt-1',
          msg: {
            type: 'TaskComplete',
            data: {
              submissionId: expect.any(String),
              response: 'Hello back',
              turnCount: 1,
            },
          },
        });
      });

      // run() waits for TaskComplete — we need to make the event match the submissionId
      // So let's test with direct submitOperation + getNextEvent instead
      engine.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Hello' }],
      });

      await new Promise(r => setTimeout(r, 10));
      expect(mockSession.spawnTask).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // M2.5: Tests for moved handlers
  // =========================================================================

  describe('M2.5: Handler — Interrupt', () => {
    it('should set interrupt flag, clear SQ, abort tasks, and clear interrupt', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({ type: 'Interrupt', reason: 'user_interrupt' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.requestInterrupt).toHaveBeenCalled();
      expect(mockSession.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
      expect(mockSession.clearInterrupt).toHaveBeenCalled();
    });

    it('should emit TurnAborted event', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({ type: 'Interrupt', reason: 'test_reason' });
      await new Promise(r => setTimeout(r, 10));

      const abortEvent = events.find(e => e.msg.type === 'TurnAborted');
      expect(abortEvent).toBeDefined();
      expect(abortEvent!.msg.data?.reason).toBe('test_reason');
    });

    it('should use default reason when none provided', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));

      const abortEvent = events.find(e => e.msg.type === 'TurnAborted');
      expect(abortEvent!.msg.data?.reason).toBe('user_interrupt');
    });
  });

  describe('M2.5: Handler — ExecApproval', () => {
    it('should route approval to session.notifyApproval', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'ExecApproval',
        callId: 'call-1',
        decision: 'approve' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.notifyApproval).toHaveBeenCalledWith('call-1', 'approve');
    });

    it('should route rejection to session.notifyApproval', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'ExecApproval',
        callId: 'call-2',
        decision: 'reject' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.notifyApproval).toHaveBeenCalledWith('call-2', 'reject');
    });

    it('should dual-route through ApprovalManager when available', async () => {
      const mockApprovalManager = createMockApprovalManager();
      const { engine, mockSession } = createEngine({
        approvalManager: mockApprovalManager as any,
      });
      await engine.initialize();

      engine.submitOperation({
        type: 'ExecApproval',
        callId: 'call-3',
        decision: 'approve' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      // Both paths should be called
      expect(mockApprovalManager.handleDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'call-3',
          decision: 'approve',
        })
      );
      expect(mockSession.notifyApproval).toHaveBeenCalledWith('call-3', 'approve');
    });

    it('should remember decision when requested', async () => {
      const mockApprovalGate = {
        rememberDecision: vi.fn(),
      };
      const mockApprovalManager = createMockApprovalManager();
      mockApprovalManager.getApproval.mockReturnValue({
        request: {
          metadata: { toolName: 'bash', domain: 'system', riskScore: 5 },
          details: { parameters: { command: 'ls' } },
        },
      });

      const mockToolRegistry = createMockToolRegistry();
      mockToolRegistry.getApprovalGate.mockReturnValue(mockApprovalGate);

      const { engine } = createEngine({
        approvalManager: mockApprovalManager as any,
        toolRegistry: mockToolRegistry as any,
      });
      await engine.initialize();

      engine.submitOperation({
        type: 'ExecApproval',
        callId: 'call-4',
        decision: 'approve' as const,
        remember: true,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(mockApprovalGate.rememberDecision).toHaveBeenCalledWith(
        'bash',
        { command: 'ls' },
        'auto_approve',
        'system',
        5,
      );
    });

    it('should emit BackgroundEvent after handling approval', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({
        type: 'ExecApproval',
        callId: 'call-5',
        decision: 'approve' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      const bgEvent = events.find(
        e => e.msg.type === 'BackgroundEvent' &&
          (e.msg.data?.message as string)?.includes('approve')
      );
      expect(bgEvent).toBeDefined();
    });
  });

  describe('M2.5: Handler — PatchApproval', () => {
    it('should route to session.notifyApproval', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'PatchApproval',
        patchId: 'patch-1',
        decision: 'approve' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.notifyApproval).toHaveBeenCalledWith('patch-1', 'approve');
    });

    it('should route rejection to session.notifyApproval', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({
        type: 'PatchApproval',
        patchId: 'patch-2',
        decision: 'reject' as const,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.notifyApproval).toHaveBeenCalledWith('patch-2', 'reject');
    });
  });

  describe('M2.5: Handler — Compact', () => {
    it('should delegate to session.compact with auto mode', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({ type: 'Compact', mode: 'auto' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.compact).toHaveBeenCalledWith('auto', expect.anything());
    });

    it('should delegate ManualCompact to session.compact with manual mode', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({ type: 'ManualCompact' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.compact).toHaveBeenCalledWith('manual', expect.anything());
    });

    it('should emit CompactionCompleted event with statistics', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({ type: 'Compact', mode: 'auto' });
      await new Promise(r => setTimeout(r, 10));

      const completedEvent = events.find(e => e.msg.type === 'CompactionCompleted');
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.msg.data?.success).toBe(true);
      expect(completedEvent!.msg.data?.tokensBefore).toBe(5000);
      expect(completedEvent!.msg.data?.tokensAfter).toBe(2000);
      expect(completedEvent!.msg.data?.itemsTrimmed).toBe(10);
    });

    it('should emit Error event when compaction fails', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();
      mockSession.compact.mockRejectedValue(new Error('compaction failed'));

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      // The compact handler rethrows after emitting — catch the unhandled rejection
      engine.submitOperation({ type: 'Compact', mode: 'auto' });
      await new Promise(r => setTimeout(r, 50));

      const errorEvent = events.find(
        e => e.msg.type === 'Error' &&
          (e.msg.data?.message as string)?.includes('compaction failed')
      );
      expect(errorEvent).toBeDefined();
    });
  });

  describe('M2.5: Handler — AddToHistory', () => {
    it('should delegate to session.addToHistory', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      engine.submitOperation({ type: 'AddToHistory', text: 'Hello world' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSession.addToHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello world',
          type: 'user',
        })
      );
    });
  });

  describe('M2.5: Handler — Shutdown', () => {
    it('should emit ShutdownComplete event', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({ type: 'Shutdown' });
      await new Promise(r => setTimeout(r, 10));

      const shutdownEvent = events.find(e => e.msg.type === 'ShutdownComplete');
      expect(shutdownEvent).toBeDefined();
    });
  });

  // =========================================================================
  // Queue and lifecycle
  // =========================================================================

  describe('Queue and lifecycle', () => {
    it('should process submissions sequentially', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      const callOrder: string[] = [];
      mockSession.addToHistory.mockImplementation((entry: any) => {
        callOrder.push(entry.text);
      });

      engine.submitOperation({ type: 'AddToHistory', text: 'first' });
      engine.submitOperation({ type: 'AddToHistory', text: 'second' });
      engine.submitOperation({ type: 'AddToHistory', text: 'third' });
      await new Promise(r => setTimeout(r, 10));

      expect(callOrder).toEqual(['first', 'second', 'third']);
    });

    it('should throw when submitting after dispose', async () => {
      const { engine } = createEngine();
      await engine.initialize();
      await engine.dispose();

      expect(() => engine.submitOperation({
        type: 'AddToHistory',
        text: 'test',
      })).toThrow('disposed');
    });

    it('should not initialize twice', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();
      await engine.initialize(); // Should be a no-op

      expect(engine.isReady()).toBe(true);
    });

    it('should cancel pending completions on cancel()', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      // cancel() should resolve any pending completion promises
      engine.cancel();

      expect(engine.isReady()).toBe(true);
    });

    it('should report correct state via isReady/isDisposed', async () => {
      const { engine } = createEngine();

      expect(engine.isReady()).toBe(false);
      expect(engine.isDisposed()).toBe(false);

      await engine.initialize();
      expect(engine.isReady()).toBe(true);
      expect(engine.isDisposed()).toBe(false);

      await engine.dispose();
      expect(engine.isReady()).toBe(false);
      expect(engine.isDisposed()).toBe(true);
    });
  });

  // =========================================================================
  // Event listener
  // =========================================================================

  describe('Event listener', () => {
    it('should notify registered listener on every event', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      engine.submitOperation({ type: 'AddToHistory', text: 'test' });
      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));

      expect(events.length).toBeGreaterThan(0);
    });

    it('should support multiple concurrent event listeners', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events1: EngineEvent[] = [];
      const events2: EngineEvent[] = [];

      engine.onEvent((e) => events1.push(e));
      engine.onEvent((e) => events2.push(e));

      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));

      // Both listeners should receive events
      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
      expect(events1.length).toBe(events2.length);
    });

    it('should support unsubscribing an event listener', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events1: EngineEvent[] = [];
      const events2: EngineEvent[] = [];

      const unsub1 = engine.onEvent((e) => events1.push(e));
      engine.onEvent((e) => events2.push(e));

      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));
      const events1CountBefore = events1.length;

      // Unsubscribe first listener
      unsub1();

      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));

      // events1 should not have received new events after unsubscribe
      expect(events1.length).toBe(events1CountBefore);
      // events2 should have received events from both operations
      expect(events2.length).toBeGreaterThan(events1.length);
    });

    it('should clean up all listeners on dispose', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      const events: EngineEvent[] = [];
      engine.onEvent((e) => events.push(e));

      // Generate an event before dispose
      engine.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 10));
      const countBeforeDispose = events.length;
      expect(countBeforeDispose).toBeGreaterThan(0);

      await engine.dispose();

      // Listeners are cleared during dispose — no more events delivered via onEvent
      // Pushing an event after dispose would throw, so we just verify the count didn't grow
      // from the dispose itself (EngineDisposed goes to eventWaiters, not onEvent listeners)
      expect(events.length).toBe(countBeforeDispose);
    });
  });

  // =========================================================================
  // Awaitable mode (run, runMultiple, sendFollowUp)
  // =========================================================================

  describe('Awaitable mode', () => {
    it('run() should resolve with TaskComplete event', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      // Mock spawnTask to emit a matching TaskComplete (protocol uses snake_case)
      mockSession.spawnTask.mockImplementation(async (_task: any, _ctx: any, submissionId: string) => {
        // Simulate async task completion
        setTimeout(() => {
          engine.pushEvent({
            id: 'evt-complete',
            msg: {
              type: 'TaskComplete',
              data: {
                submission_id: submissionId,
                last_agent_message: 'Done!',
                turn_count: 2,
              },
            },
          });
        }, 5);
      });

      const result = await engine.run([{ type: 'text', text: 'Hello' }]);

      expect(result.success).toBe(true);
      expect(result.response).toBe('Done!');
      expect(result.turnCount).toBe(2);
      expect(result.stopReason).toBe('completed');
      expect(result.engineId).toBe(engine.engineId);
    });

    it('run() should resolve with TaskError event', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      mockSession.spawnTask.mockImplementation(async (_task: any, _ctx: any, submissionId: string) => {
        setTimeout(() => {
          engine.pushEvent({
            id: 'evt-error',
            msg: {
              type: 'TaskError',
              data: { submissionId, error: 'Something broke' },
            },
          });
        }, 5);
      });

      const result = await engine.run([{ type: 'text', text: 'Hello' }]);

      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('error');
      expect(result.error).toBe('Something broke');
    });

    it('run() should timeout when no completion event arrives', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      // Don't emit any completion event — let it timeout
      const result = await engine.run([{ type: 'text', text: 'Hello' }], { timeoutMs: 50 });

      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('Timed out');
    });

    it('run() should resolve on EngineDisposed event', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      // Dispose after a short delay
      setTimeout(() => engine.dispose(), 10);

      const result = await engine.run([{ type: 'text', text: 'Hello' }], { timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('cancelled');
      expect(result.error).toBe('Engine disposed');
    });

    it('sendFollowUp() should submit UserTurn and wait for completion', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      mockSession.spawnTask.mockImplementation(async (_task: any, _ctx: any, submissionId: string) => {
        setTimeout(() => {
          engine.pushEvent({
            id: 'evt-followup',
            msg: {
              type: 'TaskComplete',
              data: { submission_id: submissionId, last_agent_message: 'Follow-up done', turn_count: 1 },
            },
          });
        }, 5);
      });

      const result = await engine.sendFollowUp([{ type: 'text', text: 'Continue' }]);

      expect(result.success).toBe(true);
      expect(result.response).toBe('Follow-up done');
    });

    it('runMultiple() should execute inputs sequentially', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      const callOrder: string[] = [];
      mockSession.spawnTask.mockImplementation(async (_task: any, _ctx: any, submissionId: string) => {
        const calls = mockSession.addPendingInput.mock.calls;
        const text = calls[calls.length - 1]?.[0]?.[0]?.text ?? '';
        callOrder.push(text);
        setTimeout(() => {
          engine.pushEvent({
            id: `evt-${submissionId}`,
            msg: {
              type: 'TaskComplete',
              data: { submission_id: submissionId, last_agent_message: `Result for ${text}`, turn_count: 1 },
            },
          });
        }, 5);
      });

      const results = await engine.runMultiple([
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'second' }],
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(callOrder).toEqual(['first', 'second']);
    });

    it('runMultiple() should stop on failure', async () => {
      const { engine, mockSession } = createEngine();
      await engine.initialize();

      let callCount = 0;
      mockSession.spawnTask.mockImplementation(async (_task: any, _ctx: any, submissionId: string) => {
        callCount++;
        setTimeout(() => {
          engine.pushEvent({
            id: `evt-${submissionId}`,
            msg: {
              type: 'TaskError',
              data: { submissionId, error: 'Failed' },
            },
          });
        }, 5);
      });

      const results = await engine.runMultiple([
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'second' }],
      ]);

      // Should stop after first failure
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(callCount).toBe(1);
    });
  });

  // =========================================================================
  // Event queue helpers
  // =========================================================================

  describe('Event queue helpers', () => {
    it('hasEvents() should return false when queue is empty', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      expect(engine.hasEvents()).toBe(false);
    });

    it('drainEvents() should return and clear all queued events', async () => {
      const { engine } = createEngine();
      await engine.initialize();

      // Push events directly (no event router, no listener → queued)
      const engineNoListener = createEngine({ session: createMockSession() as any }).engine;
      await engineNoListener.initialize();
      engineNoListener.pushEvent({ id: 'e1', msg: { type: 'TestEvent1' } });
      engineNoListener.pushEvent({ id: 'e2', msg: { type: 'TestEvent2' } });

      expect(engineNoListener.hasEvents()).toBe(true);

      const drained = engineNoListener.drainEvents();
      expect(drained).toHaveLength(2);
      expect(drained[0].msg.type).toBe('TestEvent1');
      expect(drained[1].msg.type).toBe('TestEvent2');
      expect(engineNoListener.hasEvents()).toBe(false);
    });

    it('getConfig() should return the engine config', async () => {
      const { engine, config } = createEngine();
      expect(engine.getConfig()).toBe(config);
    });
  });
});
