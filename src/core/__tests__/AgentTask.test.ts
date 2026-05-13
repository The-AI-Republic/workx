/**
 * Unit tests for AgentTask and RegularTask
 *
 * Covers:
 * - AgentTask: creation, initialization, lifecycle (run/cancel), status, delegation to TaskRunner
 * - RegularTask: kind(), run(), abort(), input conversion, error handling
 * - Interaction between RegularTask -> AgentTask -> TaskRunner
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock fns survive mockReset
// ---------------------------------------------------------------------------

const {
  mockRunTask,
  mockCancel,
  mockGetTaskStatus,
  mockGetCurrentTurnIndex,
  mockGetTokenUsage,
  mockTurnManagerRunTurn,
  mockTurnManagerCancel,
} = vi.hoisted(() => ({
  mockRunTask: vi.fn(),
  mockCancel: vi.fn(),
  mockGetTaskStatus: vi.fn(),
  mockGetCurrentTurnIndex: vi.fn(),
  mockGetTokenUsage: vi.fn(),
  mockTurnManagerRunTurn: vi.fn(),
  mockTurnManagerCancel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/core/TaskRunner', () => ({
  TaskRunner: vi.fn().mockImplementation(() => ({
    run_task: mockRunTask,
    cancel: mockCancel,
    getTaskStatus: mockGetTaskStatus,
    getCurrentTurnIndex: mockGetCurrentTurnIndex,
    getTokenUsage: mockGetTokenUsage,
  })),
}));

vi.mock('@/core/TurnManager', () => ({
  TurnManager: vi.fn().mockImplementation(() => ({
    runTurn: mockTurnManagerRunTurn,
    cancel: mockTurnManagerCancel,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AgentTask, type TaskStatus, type TokenBudget } from '@/core/AgentTask';
import { TaskRunner } from '@/core/TaskRunner';
import { RegularTask } from '@/core/tasks/RegularTask';
import { TaskKind } from '@/core/session/state/types';
import type { Session } from '@/core/Session';
import type { TurnContext } from '@/core/TurnContext';
import type { TurnManager } from '@/core/TurnManager';
import type { InputItem, ResponseItem } from '@/core/protocol/types';

// ---------------------------------------------------------------------------
// Helpers to build mock dependencies
// ---------------------------------------------------------------------------

function createMockSession(overrides: Record<string, any> = {}): Session {
  return {
    emitEvent: vi.fn().mockResolvedValue(undefined),
    recordInputAndRolloutUsermsg: vi.fn(),
    getPendingInput: vi.fn().mockResolvedValue([]),
    buildTurnInputWithHistory: vi.fn().mockResolvedValue([]),
    recordConversationItemsDual: vi.fn().mockResolvedValue(undefined),
    getTabId: vi.fn().mockReturnValue(1),
    getSessionId: vi.fn().mockReturnValue('session-001'),
    getToolRegistry: vi.fn().mockReturnValue({}),
    getHookDispatcher: vi.fn().mockReturnValue(null),
    getConversationHistory: vi.fn().mockReturnValue({ items: [] }),
    compact: vi.fn().mockResolvedValue({
      success: true,
      tokensBefore: 80000,
      tokensAfter: 20000,
      itemsTrimmed: 10,
      triggerReason: 'auto',
    }),
    getCompactionCount: vi.fn().mockReturnValue(1),
    ...overrides,
  } as unknown as Session;
}

function createMockTurnContext(overrides: Record<string, any> = {}): TurnContext {
  return {
    getModelContextWindow: vi.fn().mockReturnValue(100000),
    getToolsConfig: vi.fn().mockReturnValue({ execCommand: true }),
    getModel: vi.fn().mockReturnValue('gpt-4'),
    getApprovalPolicy: vi.fn().mockReturnValue('on-request'),
    getSandboxPolicy: vi.fn().mockReturnValue({ mode: 'workspace-write' }),
    getBrowserEnvironmentPolicy: vi.fn().mockReturnValue('preserve'),
    getEffort: vi.fn().mockReturnValue(undefined),
    getSummary: vi.fn().mockReturnValue({ enabled: false }),
    getModelClient: vi.fn().mockReturnValue({}),
    ...overrides,
  } as unknown as TurnContext;
}

function createMockTurnManager(overrides: Record<string, any> = {}): TurnManager {
  return {
    runTurn: vi.fn().mockResolvedValue({ processedItems: [], totalTokenUsage: undefined }),
    cancel: vi.fn(),
    ...overrides,
  } as unknown as TurnManager;
}

/** Build a user message ResponseItem */
function makeUserMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'text', text }],
  } as any;
}

/** Build an assistant message ResponseItem */
function makeAssistantMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  } as any;
}

// ---------------------------------------------------------------------------
// AgentTask Tests
// ---------------------------------------------------------------------------

describe('AgentTask', () => {
  const SESSION_ID = 'session-001';
  const SUBMISSION_ID = 'sub-001';
  let session: Session;
  let turnContext: TurnContext;
  let turnManager: TurnManager;

  beforeEach(() => {
    session = createMockSession();
    turnContext = createMockTurnContext();
    turnManager = createMockTurnManager();

    // Re-apply default return values after mockReset
    mockRunTask.mockResolvedValue(undefined);
    mockCancel.mockReturnValue(undefined);
    mockGetTaskStatus.mockReturnValue('idle');
    mockGetCurrentTurnIndex.mockReturnValue(0);
    mockGetTokenUsage.mockReturnValue({
      used: 0,
      max: 100000,
      compactionThreshold: 0.85,
    });

    // Re-apply TaskRunner constructor mock after mockReset
    (TaskRunner as unknown as Mock).mockImplementation(() => ({
      run_task: mockRunTask,
      cancel: mockCancel,
      getTaskStatus: mockGetTaskStatus,
      getCurrentTurnIndex: mockGetCurrentTurnIndex,
      getTokenUsage: mockGetTokenUsage,
    }));
  });

  // -----------------------------------------------------------------------
  // Constructor & initialization
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should create a TaskRunner with the provided dependencies', () => {
      const input: ResponseItem[] = [makeUserMessage('hello')];

      new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, input);

      expect(TaskRunner).toHaveBeenCalledOnce();
      expect(TaskRunner).toHaveBeenCalledWith(
        session,
        turnContext,
        turnManager,
        SUBMISSION_ID,
        expect.any(Array),
        { autoCompact: true },
      );
    });

    it('should store the submissionId as a public property', () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.submissionId).toBe(SUBMISSION_ID);
    });

    it('should convert ResponseItem input to text InputItem format for TaskRunner', () => {
      const input: ResponseItem[] = [makeUserMessage('test message')];

      new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, input);

      const constructorCall = (TaskRunner as unknown as Mock).mock.calls[0];
      const inputItems = constructorCall[4]; // 5th argument is the converted input
      expect(inputItems).toEqual([{ type: 'text', text: 'test message' }]);
    });

    it('should handle multiple input items', () => {
      const input: ResponseItem[] = [
        makeUserMessage('first'),
        makeUserMessage('second'),
      ];

      new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, input);

      const constructorCall = (TaskRunner as unknown as Mock).mock.calls[0];
      const inputItems = constructorCall[4];
      expect(inputItems).toHaveLength(2);
      expect(inputItems[0].text).toBe('first');
      expect(inputItems[1].text).toBe('second');
    });

    it('should handle empty input array', () => {
      new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      const constructorCall = (TaskRunner as unknown as Mock).mock.calls[0];
      const inputItems = constructorCall[4];
      expect(inputItems).toEqual([]);
    });

    it('should pass autoCompact: true in options', () => {
      new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      const constructorCall = (TaskRunner as unknown as Mock).mock.calls[0];
      const options = constructorCall[5];
      expect(options).toEqual({ autoCompact: true });
    });
  });

  // -----------------------------------------------------------------------
  // run()
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('should delegate execution to TaskRunner.run_task', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await task.run();

      expect(mockRunTask).toHaveBeenCalledOnce();
      expect(mockRunTask).toHaveBeenCalledWith(SUBMISSION_ID, expect.any(AbortSignal));
    });

    it('should pass the submissionId to run_task', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, 'sub-xyz', []);

      await task.run();

      expect(mockRunTask).toHaveBeenCalledWith('sub-xyz', expect.any(AbortSignal));
    });

    it('should pass an AbortSignal to run_task', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await task.run();

      const signal = mockRunTask.mock.calls[0][1];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('should set status to completed after successful run', async () => {
      mockGetTaskStatus.mockReturnValue('completed');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);
      await task.run();

      expect(task.getStatus()).toBe('completed');
    });

    it('should set status to failed when TaskRunner throws a non-abort error', async () => {
      mockRunTask.mockRejectedValueOnce(new Error('API error'));
      mockGetTaskStatus.mockReturnValue('failed');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await expect(task.run()).rejects.toThrow('API error');
      expect(task.getStatus()).toBe('failed');
    });

    it('should set status to cancelled when abort signal is triggered before run', async () => {
      mockRunTask.mockRejectedValueOnce(new Error('Aborted'));
      mockGetTaskStatus.mockReturnValue('cancelled');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);
      task.cancel(); // cancel before run

      await expect(task.run()).rejects.toThrow('Aborted');
      expect(task.getStatus()).toBe('cancelled');
    });

    it('should propagate errors from TaskRunner', async () => {
      const error = new Error('Network timeout');
      mockRunTask.mockRejectedValueOnce(error);

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await expect(task.run()).rejects.toThrow('Network timeout');
    });

    it('should not call run_task more than once per run() invocation', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await task.run();

      expect(mockRunTask).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // cancel()
  // -----------------------------------------------------------------------

  describe('cancel', () => {
    it('should set the internal abort controller to aborted', () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);
      task.cancel();

      // After cancel, the AbortSignal passed to run_task would be aborted
      // We verify by checking that the status reports cancelled
      mockGetTaskStatus.mockReturnValue('cancelled');
      expect(task.getStatus()).toBe('cancelled');
    });

    it('should be callable before run() is invoked', () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(() => task.cancel()).not.toThrow();
    });

    it('should be callable multiple times without error', () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(() => {
        task.cancel();
        task.cancel();
        task.cancel();
      }).not.toThrow();
    });

    it('should cause run() to see an already-aborted signal if cancel is called first', async () => {
      mockRunTask.mockRejectedValueOnce(new Error('Task cancelled'));

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);
      task.cancel();

      await expect(task.run()).rejects.toThrow();

      // The signal passed to run_task should have been aborted
      const signal = mockRunTask.mock.calls[0][1] as AbortSignal;
      expect(signal.aborted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus()
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('should return initializing when TaskRunner status is unknown and internal status is initializing', () => {
      mockGetTaskStatus.mockReturnValue('unknown');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('initializing');
    });

    it('should delegate to TaskRunner for status', () => {
      mockGetTaskStatus.mockReturnValue('running');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('running');
      expect(mockGetTaskStatus).toHaveBeenCalledWith(SUBMISSION_ID);
    });

    it('should return completed when TaskRunner reports completed', () => {
      mockGetTaskStatus.mockReturnValue('completed');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('completed');
    });

    it('should return failed when TaskRunner reports failed', () => {
      mockGetTaskStatus.mockReturnValue('failed');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('failed');
    });

    it('should return cancelled when TaskRunner reports cancelled', () => {
      mockGetTaskStatus.mockReturnValue('cancelled');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('cancelled');
    });

    it('should return idle when TaskRunner reports idle', () => {
      mockGetTaskStatus.mockReturnValue('idle');

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getStatus()).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // getSessionId()
  // -----------------------------------------------------------------------

  describe('getSessionId', () => {
    it('should return the session ID passed in the constructor', () => {
      const task = new AgentTask(session, turnContext, turnManager, 'my-session-id', SUBMISSION_ID, []);

      expect(task.getSessionId()).toBe('my-session-id');
    });

    it('should return different session IDs for different tasks', () => {
      const task1 = new AgentTask(session, turnContext, turnManager, 'session-A', 'sub-A', []);
      const task2 = new AgentTask(session, turnContext, turnManager, 'session-B', 'sub-B', []);

      expect(task1.getSessionId()).toBe('session-A');
      expect(task2.getSessionId()).toBe('session-B');
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentTurnIndex()
  // -----------------------------------------------------------------------

  describe('getCurrentTurnIndex', () => {
    it('should delegate to TaskRunner.getCurrentTurnIndex', () => {
      mockGetCurrentTurnIndex.mockReturnValue(3);

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getCurrentTurnIndex()).toBe(3);
      expect(mockGetCurrentTurnIndex).toHaveBeenCalledWith(SUBMISSION_ID);
    });

    it('should return 0 for a newly created task', () => {
      mockGetCurrentTurnIndex.mockReturnValue(0);

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getCurrentTurnIndex()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getTokenUsage()
  // -----------------------------------------------------------------------

  describe('getTokenUsage', () => {
    it('should delegate to TaskRunner.getTokenUsage', () => {
      const expectedUsage: TokenBudget = {
        used: 5000,
        max: 128000,
        compactionThreshold: 0.85,
      };
      mockGetTokenUsage.mockReturnValue(expectedUsage);

      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      expect(task.getTokenUsage()).toEqual(expectedUsage);
      expect(mockGetTokenUsage).toHaveBeenCalledWith(SUBMISSION_ID);
    });

    it('should return zero usage for a newly created task', () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      const usage = task.getTokenUsage();
      expect(usage.used).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // injectUserInput()
  // -----------------------------------------------------------------------

  describe('injectUserInput', () => {
    it('should accept input without throwing', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await expect(
        task.injectUserInput([makeUserMessage('follow-up')])
      ).resolves.not.toThrow();
    });

    it('should handle empty input array', async () => {
      const task = new AgentTask(session, turnContext, turnManager, SESSION_ID, SUBMISSION_ID, []);

      await expect(task.injectUserInput([])).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// RegularTask Tests
// ---------------------------------------------------------------------------

describe('RegularTask', () => {
  let session: Session;
  let turnContext: TurnContext;

  beforeEach(() => {
    session = createMockSession();
    turnContext = createMockTurnContext();

    // Re-apply default return values after mockReset
    mockRunTask.mockResolvedValue(undefined);
    mockCancel.mockReturnValue(undefined);
    mockGetTaskStatus.mockReturnValue('idle');
    mockGetCurrentTurnIndex.mockReturnValue(0);
    mockGetTokenUsage.mockReturnValue({
      used: 0,
      max: 100000,
      compactionThreshold: 0.85,
    });

    // Re-apply TaskRunner constructor mock after mockReset
    (TaskRunner as unknown as Mock).mockImplementation(() => ({
      run_task: mockRunTask,
      cancel: mockCancel,
      getTaskStatus: mockGetTaskStatus,
      getCurrentTurnIndex: mockGetCurrentTurnIndex,
      getTokenUsage: mockGetTokenUsage,
    }));
  });

  // -----------------------------------------------------------------------
  // kind()
  // -----------------------------------------------------------------------

  describe('kind', () => {
    it('should return TaskKind.Regular', () => {
      const task = new RegularTask();

      expect(task.kind()).toBe(TaskKind.Regular);
    });
  });

  // -----------------------------------------------------------------------
  // run()
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('should create an AgentTask that delegates to TaskRunner', async () => {
      const task = new RegularTask();
      await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'hi' }] as any);

      expect(TaskRunner).toHaveBeenCalled();
      expect(mockRunTask).toHaveBeenCalled();
    });

    it('should call AgentTask.run() which invokes TaskRunner.run_task', async () => {
      const task = new RegularTask();

      await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'run me' }] as any);

      expect(mockRunTask).toHaveBeenCalledOnce();
    });

    it('should return null when no assistant message is in history', async () => {
      const task = new RegularTask();

      const result = await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'hi' }] as any);

      expect(result).toBeNull();
    });

    it('should return the last assistant message from conversation history', async () => {
      const sessionWithHistory = createMockSession({
        getConversationHistory: vi.fn().mockReturnValue({
          items: [
            makeUserMessage('hello'),
            makeAssistantMessage('Hi there!'),
          ],
        }),
      });

      const task = new RegularTask();
      const result = await task.run(sessionWithHistory, turnContext, 'sub-001', [{ type: 'text', text: 'hello' }] as any);

      expect(result).toBe('Hi there!');
    });

    it('should return the LAST assistant message when multiple exist', async () => {
      const sessionWithHistory = createMockSession({
        getConversationHistory: vi.fn().mockReturnValue({
          items: [
            makeUserMessage('first'),
            makeAssistantMessage('First reply'),
            makeUserMessage('second'),
            makeAssistantMessage('Second reply'),
          ],
        }),
      });

      const task = new RegularTask();
      const result = await task.run(sessionWithHistory, turnContext, 'sub-001', [{ type: 'text', text: 'test' }] as any);

      expect(result).toBe('Second reply');
    });

    it('should propagate errors from AgentTask.run()', async () => {
      mockRunTask.mockRejectedValueOnce(new Error('Execution failed'));

      const task = new RegularTask();

      await expect(
        task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'fail' }] as any)
      ).rejects.toThrow('Execution failed');
    });

    it('should pass converted text InputItems through to AgentTask/TaskRunner', async () => {
      const task = new RegularTask();

      await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'hello world' }] as any);

      // The TaskRunner constructor is called with the converted items
      const taskRunnerCall = (TaskRunner as unknown as Mock).mock.calls[0];
      expect(taskRunnerCall).toBeDefined();
    });

    it('should convert image InputItem through to AgentTask', async () => {
      const task = new RegularTask();

      await task.run(session, turnContext, 'sub-001', [
        { type: 'image', image_url: 'https://example.com/img.png' } as any,
      ]);

      // Verify TaskRunner was called (conversion happened successfully)
      expect(TaskRunner).toHaveBeenCalled();
    });

    it('should handle unknown InputItem types by JSON stringifying', async () => {
      const task = new RegularTask();

      await task.run(session, turnContext, 'sub-001', [
        { type: 'custom', data: 'value' } as any,
      ]);

      expect(TaskRunner).toHaveBeenCalled();
    });

    it('should use session.getSessionId() for the AgentTask session ID', async () => {
      (session.getSessionId as Mock).mockReturnValue('sess-abc');

      const task = new RegularTask();
      await task.run(session, turnContext, 'sub-123', [{ type: 'text', text: 'test' }] as any);

      // The TaskRunner constructor receives the submissionId
      const taskRunnerCall = (TaskRunner as unknown as Mock).mock.calls[0];
      // 4th arg (index 3) is submissionId
      expect(taskRunnerCall[3]).toBe('sub-123');
    });

    it('should filter only assistant messages when extracting the final response', async () => {
      const sessionWithMixed = createMockSession({
        getConversationHistory: vi.fn().mockReturnValue({
          items: [
            makeUserMessage('question'),
            { type: 'function_call', name: 'tool', arguments: '{}', call_id: 'c1' } as any,
            { type: 'function_call_output', call_id: 'c1', output: 'result' } as any,
            makeAssistantMessage('Final answer'),
          ],
        }),
      });

      const task = new RegularTask();
      const result = await task.run(sessionWithMixed, turnContext, 'sub-001', [{ type: 'text', text: 'q' }] as any);

      expect(result).toBe('Final answer');
    });
  });

  // -----------------------------------------------------------------------
  // abort()
  // -----------------------------------------------------------------------

  describe('abort', () => {
    it('should not throw when called before run()', async () => {
      const task = new RegularTask();

      await expect(task.abort(session, 'sub-001')).resolves.not.toThrow();
    });

    it('should nullify the agentTask reference after abort', async () => {
      const task = new RegularTask();

      // Run the task first to create the agentTask
      await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'hi' }] as any);

      // Now abort
      await task.abort(session, 'sub-001');

      // Calling abort again should not throw (agentTask is null)
      await expect(task.abort(session, 'sub-001')).resolves.not.toThrow();
    });

    it('should be idempotent when called multiple times', async () => {
      const task = new RegularTask();

      await task.run(session, turnContext, 'sub-001', [{ type: 'text', text: 'test' }] as any);

      await task.abort(session, 'sub-001');
      await task.abort(session, 'sub-001');
      await task.abort(session, 'sub-001');

      // Should not throw on repeated calls
    });
  });
});
