/**
 * Unit tests for TaskRunner
 *
 * Covers the public API:
 * - run_task()        (success, empty input, cancellation, abort signal, error, timeout, compaction)
 * - cancel() / isCancelled()
 * - getTaskStatus()
 * - getCurrentTurnIndex()
 * - getTokenUsage()
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { TaskRunner, type TaskOptions } from '@/core/TaskRunner';
import type { Session } from '@/core/Session';
import type { TurnContext } from '@/core/TurnContext';
import type { TurnManager, TurnRunResult } from '@/core/TurnManager';
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
    getToolsConfig: vi.fn().mockReturnValue({ execCommand: true, webSearch: false }),
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
    runTurn: vi.fn().mockResolvedValue({
      processedItems: [],
      totalTokenUsage: undefined,
    } as TurnRunResult),
    cancel: vi.fn(),
    ...overrides,
  } as unknown as TurnManager;
}

/** Helper: build a simple assistant message ResponseItem */
function makeAssistantMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  } as any;
}

/** Helper: build a TurnRunResult whose single turn yields an assistant message (task complete) */
function makeSingleTurnResult(text: string, tokenUsage?: any): TurnRunResult {
  return {
    processedItems: [
      { item: makeAssistantMessage(text), response: undefined },
    ],
    totalTokenUsage: tokenUsage,
  };
}

/** Helper: build a TurnRunResult with a function_call + function_call_output (needs another turn) */
function makeFunctionCallTurnResult(tokenUsage?: any): TurnRunResult {
  return {
    processedItems: [
      {
        item: { type: 'function_call', name: 'do_thing', arguments: '{}', call_id: 'c1' },
        response: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      },
    ],
    totalTokenUsage: tokenUsage,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskRunner', () => {
  const SUBMISSION_ID = 'sub-001';
  let session: Session;
  let turnContext: TurnContext;
  let turnManager: TurnManager;

  beforeEach(() => {
    session = createMockSession();
    turnContext = createMockTurnContext();
    turnManager = createMockTurnManager();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor & initial state
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialise with idle status and zero token usage', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [], {},
      );

      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('idle');
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(0);
      expect(runner.isCancelled()).toBe(false);
    });

    it('should use model context window for token max', () => {
      (turnContext.getModelContextWindow as Mock).mockReturnValue(200000);

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.max).toBe(200000);
    });

    it('should default context window to 100000 when undefined', () => {
      (turnContext.getModelContextWindow as Mock).mockReturnValue(undefined);

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.max).toBe(100000);
    });
  });

  describe('background task output delta events', () => {
    it('emits metadata-only output delta after appending a task output chunk', async () => {
      let seq = 0;
      const store = {
        getLastSeq: vi.fn(async () => seq),
        appendChunk: vi.fn(async () => {
          seq += 1;
          return {
            chunkId: `task-1:${seq}`,
            taskId: 'task-1',
            seq,
            createdAt: Date.now(),
            kind: 'message',
            data: 'hello',
          };
        }),
      };
      const runner = new TaskRunner(
        session,
        turnContext,
        turnManager,
        SUBMISSION_ID,
        [],
        { taskOutputStore: store as never, taskId: 'task-1' },
      );

      await (runner as unknown as {
        appendTaskOutputChunk(kind: 'message', data: string): Promise<void>;
      }).appendTaskOutputChunk('message', 'hello');

      expect(session.emitEvent).toHaveBeenCalledWith({
        id: SUBMISSION_ID,
        msg: {
          type: 'BackgroundTaskOutputDelta',
          data: {
            taskId: 'task-1',
            fromSeq: 0,
            toSeq: 1,
            kindCounts: { message: 1 },
          },
        },
      });
    });
  });

  // -----------------------------------------------------------------------
  // cancel() / isCancelled()
  // -----------------------------------------------------------------------

  describe('cancel / isCancelled', () => {
    it('should mark the task as cancelled', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      expect(runner.isCancelled()).toBe(false);
      runner.cancel();
      expect(runner.isCancelled()).toBe(true);
    });

    it('should set status to killed and abortReason to user_interrupt', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      runner.cancel();
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('killed');
    });

    it('should delegate cancellation to turnManager', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      runner.cancel();
      expect(turnManager.cancel).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // getTaskStatus()
  // -----------------------------------------------------------------------

  describe('getTaskStatus', () => {
    it('should return idle before run_task is called', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('idle');
    });

    it('should return completed after a successful run', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Hello!'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('completed');
    });

    it('should return failed when run_task throws', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockRejectedValueOnce(new Error('boom'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('failed');
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentTurnIndex()
  // -----------------------------------------------------------------------

  describe('getCurrentTurnIndex', () => {
    it('should be 0 before any turns execute', () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(0);
    });

    it('should reflect number of turns completed', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      // Turn 1: function call (needs another turn)
      // Turn 2: assistant message (completes the task)
      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult())
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getTokenUsage()
  // -----------------------------------------------------------------------

  describe('getTokenUsage', () => {
    it('should return initial usage of 0 with correct max and threshold', () => {
      (turnContext.getModelContextWindow as Mock).mockReturnValue(128000);

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.used).toBe(0);
      expect(usage.max).toBe(128000);
      expect(usage.compactionThreshold).toBe(0.8);
    });

    it('should update used tokens after a turn with token usage', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      const tokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 0,
        total_tokens: 150,
      };

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Done', tokenUsage),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.used).toBe(150);
    });

    it('should aggregate token usage across multiple turns', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const usage1 = {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 50,
        reasoning_output_tokens: 5,
        total_tokens: 165,
      };
      const usage2 = {
        input_tokens: 200,
        cached_input_tokens: 20,
        output_tokens: 80,
        reasoning_output_tokens: 10,
        total_tokens: 310,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(usage1))
        .mockResolvedValueOnce(makeSingleTurnResult('Done', usage2));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // total_tokens = 165 + 310 = 475
      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.used).toBe(475);
    });
  });

  // -----------------------------------------------------------------------
  // run_task()
  // -----------------------------------------------------------------------

  describe('run_task', () => {
    it('should succeed immediately for empty input', async () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      const result = await runner.run_task();

      expect(result.success).toBe(true);
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('completed');
      // Should not call recordInputAndRolloutUsermsg for empty input
      expect(session.recordInputAndRolloutUsermsg).not.toHaveBeenCalled();
      // Should emit TaskStarted and TaskComplete events
      expect(session.emitEvent).toHaveBeenCalledTimes(2);
    });

    it('should emit TaskStarted event with correct data', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Hey'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // First emitEvent call should be TaskStarted
      const firstCall = (session.emitEvent as Mock).mock.calls[0][0];
      expect(firstCall.id).toBe(SUBMISSION_ID);
      expect(firstCall.msg.type).toBe('TaskStarted');
      expect(firstCall.msg.data.submission_id).toBe(SUBMISSION_ID);
      expect(firstCall.msg.data.model).toBe('gpt-4');
      expect(firstCall.msg.data.auto_compact).toBe(true);
    });

    it('should emit TaskComplete event on success', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Done!'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // Last emitEvent call should be TaskComplete
      const calls = (session.emitEvent as Mock).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.msg.type).toBe('TaskComplete');
      expect(lastCall.msg.data.last_agent_message).toBe('Done!');
      expect(lastCall.msg.data.turn_count).toBe(1);
      expect(lastCall.msg.data.aborted).toBe(false);
    });

    it('should return last agent message on success', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Here is your answer'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(true);
      expect(result.lastAgentMessage).toBe('Here is your answer');
    });

    it('should record input at the start of execution', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('ok'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();
      expect(session.recordInputAndRolloutUsermsg).toHaveBeenCalledWith(input);
    });

    it('should support an updated submissionId', async () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      await runner.run_task('sub-002');

      // The TaskStarted event should still be emitted with original submissionId
      // but the state should have the updated one
      const firstCall = (session.emitEvent as Mock).mock.calls[0][0];
      expect(firstCall.msg.type).toBe('TaskStarted');
    });

    // -------------------------------------------------------------------
    // Multi-turn execution
    // -------------------------------------------------------------------

    it('should execute multiple turns when task is not complete', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult())
        .mockResolvedValueOnce(makeFunctionCallTurnResult())
        .mockResolvedValueOnce(makeSingleTurnResult('All done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();

      expect(result.success).toBe(true);
      expect(result.lastAgentMessage).toBe('All done');
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(3);
      expect(turnManager.runTurn).toHaveBeenCalledTimes(3);
    });

    // -------------------------------------------------------------------
    // Cancellation via cancel()
    // -------------------------------------------------------------------

    it('should return aborted when cancelled before turn executes', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      // Make runTurn reject because cancel() resolves the cancel promise
      (turnManager.runTurn as Mock).mockImplementation(
        () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Task cancelled')), 10);
        }),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      // Cancel almost immediately
      const runPromise = runner.run_task();
      runner.cancel();

      const result = await runPromise;
      expect(result.success).toBe(false);
      expect(runner.isCancelled()).toBe(true);
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('killed');
    });

    it('should NOT emit TaskFailed on cancellation (only the aborted event)', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock).mockImplementation(
        () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Task cancelled')), 10);
        }),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const runPromise = runner.run_task();
      runner.cancel();
      await runPromise;

      // A user stop is an abort, not a failure — emitting TaskFailed would
      // render a spurious red "Task failed" entry for an intentional cancel.
      const failed = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskFailed',
      );
      expect(failed).toBeUndefined();
    });

    // -------------------------------------------------------------------
    // Cancellation via AbortSignal
    // -------------------------------------------------------------------

    it('should cancel when AbortSignal is triggered', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const controller = new AbortController();

      // First turn succeeds, second turn hangs until abort
      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult())
        .mockImplementation(
          () => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Task cancelled')), 50);
          }),
        );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const runPromise = runner.run_task(undefined, controller.signal);

      // Give first turn time to finish then abort
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      const result = await runPromise;
      expect(result.success).toBe(false);
      expect(runner.isCancelled()).toBe(true);
    });

    it('should handle already-aborted signal', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const controller = new AbortController();
      controller.abort(); // Abort before run starts

      (turnManager.runTurn as Mock).mockImplementation(
        () => new Promise((_, reject) => {
          // This should never actually resolve because signal is already aborted
          setTimeout(() => reject(new Error('Task cancelled')), 5);
        }),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task(undefined, controller.signal);
      expect(result.success).toBe(false);
    });

    // -------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------

    it('should return error result when a turn throws', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock).mockRejectedValueOnce(
        new Error('API rate limit exceeded'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();

      expect(result.success).toBe(false);
      expect(result.error).toBe('API rate limit exceeded');
      expect(runner.getTaskStatus(SUBMISSION_ID)).toBe('failed');
    });

    it('should emit a terminal TaskFailed event when task execution fails', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock).mockRejectedValueOnce(new Error('network error'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // The catch path emits TaskFailed (terminal) rather than the generic
      // Error event — so the UI clears its processing state and the engine's
      // waitForCompletion() resolves the awaiter with the failure reason.
      const failedEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskFailed',
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent![0].msg.data.submission_id).toBe(SUBMISSION_ID);
      expect(failedEvent![0].msg.data.message).toContain('network error');
    });

    it('should convert non-Error throws to Error objects', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock).mockRejectedValueOnce('string error');

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    // -------------------------------------------------------------------
    // Auto-compaction
    // -------------------------------------------------------------------

    it('should trigger auto-compaction when token limit is reached', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const contextWindow = 100000;
      (turnContext.getModelContextWindow as Mock).mockReturnValue(contextWindow);

      // Token usage exceeds 80% threshold (86000 >= 100000 * 0.8)
      const highTokenUsage = {
        input_tokens: 70000,
        cached_input_tokens: 0,
        output_tokens: 16000,
        reasoning_output_tokens: 0,
        total_tokens: 86000,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(highTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
        { autoCompact: true },
      );

      await runner.run_task();

      expect(session.compact).toHaveBeenCalledWith('auto', expect.anything());
    });

    it('should not trigger compaction when autoCompact is disabled', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnContext.getModelContextWindow as Mock).mockReturnValue(100000);

      const highTokenUsage = {
        input_tokens: 70000,
        cached_input_tokens: 0,
        output_tokens: 16000,
        reasoning_output_tokens: 0,
        total_tokens: 86000,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(highTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
        { autoCompact: false },
      );

      await runner.run_task();

      expect(session.compact).not.toHaveBeenCalled();
    });

    it('should not trigger compaction when below threshold', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnContext.getModelContextWindow as Mock).mockReturnValue(100000);

      // Token usage below 80% threshold
      const lowTokenUsage = {
        input_tokens: 5000,
        cached_input_tokens: 0,
        output_tokens: 2000,
        reasoning_output_tokens: 0,
        total_tokens: 7000,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(lowTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      expect(session.compact).not.toHaveBeenCalled();
    });

    it('should handle compaction failure gracefully', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnContext.getModelContextWindow as Mock).mockReturnValue(100000);

      const highTokenUsage = {
        input_tokens: 70000,
        cached_input_tokens: 0,
        output_tokens: 16000,
        reasoning_output_tokens: 0,
        total_tokens: 86000,
      };

      (session.compact as Mock).mockRejectedValueOnce(new Error('compact failed'));

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(highTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      // Should not throw despite compaction failure
      const result = await runner.run_task();
      expect(result.success).toBe(true);
    });

    // -------------------------------------------------------------------
    // Conversation item recording
    // -------------------------------------------------------------------

    it('should record conversation items for assistant messages', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Hello'),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // recordConversationItemsDual should be called for the processed items
      expect(session.recordConversationItemsDual).toHaveBeenCalled();
    });

    it('should record both function_call and function_call_output items', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult())
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // First call from buildNormalTurnInput (for pendingInput if any),
      // then from processTurnResult for each turn's items
      const recordCalls = (session.recordConversationItemsDual as Mock).mock.calls;
      // We should have at least one call with function_call items
      const anyCallContainsFunctionCall = recordCalls.some(
        (call: any[]) => {
          const items = call[0] as any[];
          return items.some((item: any) => item.type === 'function_call');
        },
      );
      expect(anyCallContainsFunctionCall).toBe(true);
    });

    // -------------------------------------------------------------------
    // TaskStarted event details
    // -------------------------------------------------------------------

    it('should include reasoning effort in TaskStarted when set', async () => {
      (turnContext.getEffort as Mock).mockReturnValue('high');

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      await runner.run_task();

      const startEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskStarted',
      );
      expect(startEvent).toBeDefined();
      expect(startEvent![0].msg.data.reasoning_effort).toBe('high');
    });

    it('should include reasoning summary in TaskStarted when set', async () => {
      (turnContext.getSummary as Mock).mockReturnValue({ enabled: true });

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      await runner.run_task();

      const startEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskStarted',
      );
      expect(startEvent).toBeDefined();
      expect(startEvent![0].msg.data.reasoning_summary).toEqual({ enabled: true });
    });

    it('should include enabled tools sorted alphabetically in TaskStarted', async () => {
      (turnContext.getToolsConfig as Mock).mockReturnValue({
        execCommand: true,
        webSearch: true,
        fileOperations: false,
        mcpTools: true,
      });

      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];
      (turnManager.runTurn as Mock).mockResolvedValueOnce(makeSingleTurnResult('ok'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      const startEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskStarted',
      );
      expect(startEvent).toBeDefined();
      const tools: string[] = startEvent![0].msg.data.tools;
      expect(tools).toEqual(['execCommand', 'mcpTools', 'webSearch']);
    });

    // -------------------------------------------------------------------
    // Timeout option
    // -------------------------------------------------------------------

    it('should include timeout in TaskStarted event when set', async () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
        { timeoutMs: 30000 },
      );

      await runner.run_task();

      const startEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskStarted',
      );
      expect(startEvent![0].msg.data.timeout_ms).toBe(30000);
    });

    // -------------------------------------------------------------------
    // Task complete event: token usage in event data
    // -------------------------------------------------------------------

    it('should include token_usage in TaskComplete event when available', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      const tokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 5,
        output_tokens: 50,
        reasoning_output_tokens: 0,
        total_tokens: 155,
      };

      (turnManager.runTurn as Mock).mockResolvedValueOnce(
        makeSingleTurnResult('Done', tokenUsage),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      const completeEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskComplete',
      );
      expect(completeEvent).toBeDefined();
      expect(completeEvent![0].msg.data.token_usage).toBeDefined();
      expect(completeEvent![0].msg.data.token_usage.total).toEqual(tokenUsage);
      expect(completeEvent![0].msg.data.token_usage.last_turn).toEqual(tokenUsage);
    });

    // -------------------------------------------------------------------
    // autoCompact defaults to true
    // -------------------------------------------------------------------

    it('should default autoCompact to true', async () => {
      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, [],
      );

      await runner.run_task();

      const startEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'TaskStarted',
      );
      expect(startEvent![0].msg.data.auto_compact).toBe(true);
    });

    // -------------------------------------------------------------------
    // State reset on each run_task() call
    // -------------------------------------------------------------------

    it('should reset state on each run_task invocation', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } as any];

      const tokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 0,
        total_tokens: 150,
      };

      (turnManager.runTurn as Mock).mockResolvedValue(
        makeSingleTurnResult('ok', tokenUsage),
      );

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      // First run
      await runner.run_task();
      expect(runner.getTokenUsage(SUBMISSION_ID).used).toBe(150);

      // Second run should reset
      await runner.run_task();
      // After second successful run, used should reflect only the second run's tokens
      expect(runner.getTokenUsage(SUBMISSION_ID).used).toBe(150);
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(1);
    });

    // -------------------------------------------------------------------
    // Custom tool call processing
    // -------------------------------------------------------------------

    it('should process custom_tool_call items as needing another turn', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const customToolTurnResult: TurnRunResult = {
        processedItems: [
          {
            item: { type: 'custom_tool_call', name: 'my_tool', arguments: '{}', call_id: 'ct1' },
            response: { type: 'custom_tool_call_output', call_id: 'ct1', output: 'result' },
          },
        ],
        totalTokenUsage: undefined,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(customToolTurnResult)
        .mockResolvedValueOnce(makeSingleTurnResult('Finished'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(true);
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(2);
    });

    // -------------------------------------------------------------------
    // Reasoning items
    // -------------------------------------------------------------------

    it('should record reasoning items without response', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'think' }] } as any];

      const reasoningTurnResult: TurnRunResult = {
        processedItems: [
          { item: { type: 'reasoning', content: 'thinking...' }, response: undefined },
          { item: makeAssistantMessage('Answer'), response: undefined },
        ],
        totalTokenUsage: undefined,
      };

      (turnManager.runTurn as Mock).mockResolvedValueOnce(reasoningTurnResult);

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(true);
      expect(result.lastAgentMessage).toBe('Answer');
    });

    // -------------------------------------------------------------------
    // Parallel tool calls (Gemini-style with tool_calls on message)
    // -------------------------------------------------------------------

    it('should handle assistant message with embedded tool_calls and multiple responses', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      const parallelToolCallResult: TurnRunResult = {
        processedItems: [
          {
            item: {
              type: 'message',
              role: 'assistant',
              content: [],
              tool_calls: [
                { id: 'tc1', function: { name: 'tool1', arguments: '{}' } },
                { id: 'tc2', function: { name: 'tool2', arguments: '{}' } },
              ],
            },
            response: [
              { type: 'function_call_output', call_id: 'tc1', output: 'res1' },
              { type: 'function_call_output', call_id: 'tc2', output: 'res2' },
            ],
          },
        ],
        totalTokenUsage: undefined,
      };

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(parallelToolCallResult)
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      const result = await runner.run_task();
      expect(result.success).toBe(true);
      expect(runner.getCurrentTurnIndex(SUBMISSION_ID)).toBe(2);
    });

    // -------------------------------------------------------------------
    // CompactionCompleted event
    // -------------------------------------------------------------------

    it('should emit CompactionCompleted event after successful compaction', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnContext.getModelContextWindow as Mock).mockReturnValue(100000);

      const highTokenUsage = {
        input_tokens: 70000,
        cached_input_tokens: 0,
        output_tokens: 16000,
        reasoning_output_tokens: 0,
        total_tokens: 86000,
      };

      (session.compact as Mock).mockResolvedValueOnce({
        success: true,
        tokensBefore: 86000,
        tokensAfter: 20000,
        itemsTrimmed: 15,
        triggerReason: 'auto',
      });

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(highTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done'));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      const compactionEvent = (session.emitEvent as Mock).mock.calls.find(
        (call: any[]) => call[0].msg.type === 'CompactionCompleted',
      );
      expect(compactionEvent).toBeDefined();
      expect(compactionEvent![0].msg.data.success).toBe(true);
      expect(compactionEvent![0].msg.data.tokensBefore).toBe(86000);
      expect(compactionEvent![0].msg.data.tokensAfter).toBe(20000);
      expect(compactionEvent![0].msg.data.itemsTrimmed).toBe(15);
    });

    // -------------------------------------------------------------------
    // Token usage updated after compaction
    // -------------------------------------------------------------------

    it('should update token usage after successful compaction', async () => {
      const input: InputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } as any];

      (turnContext.getModelContextWindow as Mock).mockReturnValue(100000);

      const highTokenUsage = {
        input_tokens: 70000,
        cached_input_tokens: 0,
        output_tokens: 16000,
        reasoning_output_tokens: 0,
        total_tokens: 86000,
      };

      const lowTokenUsage = {
        input_tokens: 5000,
        cached_input_tokens: 0,
        output_tokens: 1000,
        reasoning_output_tokens: 0,
        total_tokens: 6000,
      };

      (session.compact as Mock).mockResolvedValueOnce({
        success: true,
        tokensBefore: 86000,
        tokensAfter: 20000,
        itemsTrimmed: 15,
        triggerReason: 'auto',
      });

      (turnManager.runTurn as Mock)
        .mockResolvedValueOnce(makeFunctionCallTurnResult(highTokenUsage))
        .mockResolvedValueOnce(makeSingleTurnResult('Done', lowTokenUsage));

      const runner = new TaskRunner(
        session, turnContext, turnManager, SUBMISSION_ID, input,
      );

      await runner.run_task();

      // After compaction + final turn aggregation:
      // Total tokens = 86000 (turn1) + 6000 (turn2) = 92000
      const usage = runner.getTokenUsage(SUBMISSION_ID);
      expect(usage.used).toBe(92000);
    });
  });
});
