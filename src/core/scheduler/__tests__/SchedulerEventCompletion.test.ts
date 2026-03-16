/**
 * Tests for bootstrap-level scheduler event completion handling.
 *
 * Both ServerAgentBootstrap and DesktopAgentBootstrap use the same pattern:
 * - Track `runningSchedulerJobId` and `runningJobStartTime` when a job launches
 * - Intercept TaskComplete/TurnAborted/Error events from the agent
 * - Call scheduler.completeJob() / scheduler.failJob() with extracted data
 *
 * This test validates the logic in isolation without requiring full bootstrap init.
 * The handler code is extracted into a helper to match both bootstraps' behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventMsg } from '@/core/protocol/events';

// ---------------------------------------------------------------------------
// Extract the shared handler logic (mirrors both bootstraps)
// ---------------------------------------------------------------------------

interface CompletionHandlerState {
  runningSchedulerJobId: string | null;
  runningJobStartTime: number;
  scheduler: {
    completeJob: ReturnType<typeof vi.fn>;
    failJob: ReturnType<typeof vi.fn>;
  } | null;
}

function handleSchedulerEventCompletion(state: CompletionHandlerState, msg: EventMsg): void {
  if (!state.runningSchedulerJobId || !state.scheduler) return;
  const jobId = state.runningSchedulerJobId;
  const duration = state.runningJobStartTime > 0 ? Date.now() - state.runningJobStartTime : 0;

  if (msg.type === 'TaskComplete') {
    state.runningSchedulerJobId = null;
    state.runningJobStartTime = 0;
    const data = (msg as EventMsg & { data?: Record<string, any> }).data;
    const summary = data?.last_agent_message?.slice(0, 500) || 'Job completed';
    const tokenData = data?.token_usage?.total;
    state.scheduler.completeJob(jobId, {
      summary,
      tokenUsage: {
        inputTokens: tokenData?.input_tokens ?? 0,
        outputTokens: tokenData?.output_tokens ?? 0,
        totalTokens: tokenData?.total_tokens ?? 0,
      },
      duration,
    }).catch(() => {});
  } else if (msg.type === 'TaskFailed' || msg.type === 'TurnAborted' || msg.type === 'Error') {
    state.runningSchedulerJobId = null;
    state.runningJobStartTime = 0;
    const data = (msg as EventMsg & { data?: Record<string, any> }).data;
    const error = data?.error || data?.reason || data?.message || 'Job failed';
    state.scheduler.failJob(jobId, error).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSchedulerEventCompletion (bootstrap pattern)', () => {
  let state: CompletionHandlerState;

  beforeEach(() => {
    state = {
      runningSchedulerJobId: 'job-123',
      runningJobStartTime: Date.now() - 5000, // Started 5 seconds ago
      scheduler: {
        completeJob: vi.fn().mockResolvedValue(undefined),
        failJob: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  // =========================================================================
  // TaskComplete
  // =========================================================================

  describe('TaskComplete', () => {
    it('should call scheduler.completeJob with extracted data', () => {
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: {
          last_agent_message: 'The task is done.',
          token_usage: {
            total: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.completeJob).toHaveBeenCalledWith('job-123', {
        summary: 'The task is done.',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        duration: expect.any(Number),
      });
    });

    it('should compute duration from runningJobStartTime', () => {
      const startTime = Date.now() - 10_000; // 10 seconds ago
      state.runningJobStartTime = startTime;

      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);

      const result = state.scheduler!.completeJob.mock.calls[0][1];
      // Duration should be approximately 10 seconds (allow 1s tolerance)
      expect(result.duration).toBeGreaterThanOrEqual(9_000);
      expect(result.duration).toBeLessThan(12_000);
    });

    it('should use 0 duration when runningJobStartTime is 0', () => {
      state.runningJobStartTime = 0;

      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);

      const result = state.scheduler!.completeJob.mock.calls[0][1];
      expect(result.duration).toBe(0);
    });

    it('should default summary when last_agent_message is missing', () => {
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: {},
      };

      handleSchedulerEventCompletion(state, msg);

      const result = state.scheduler!.completeJob.mock.calls[0][1];
      expect(result.summary).toBe('Job completed');
    });

    it('should truncate summary to 500 chars', () => {
      const longMessage = 'x'.repeat(1000);
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: longMessage },
      };

      handleSchedulerEventCompletion(state, msg);

      const result = state.scheduler!.completeJob.mock.calls[0][1];
      expect(result.summary.length).toBe(500);
    });

    it('should default token counts to 0 when missing', () => {
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);

      const result = state.scheduler!.completeJob.mock.calls[0][1];
      expect(result.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
    });

    it('should clear runningSchedulerJobId and runningJobStartTime', () => {
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.runningSchedulerJobId).toBeNull();
      expect(state.runningJobStartTime).toBe(0);
    });
  });

  // =========================================================================
  // TaskFailed
  // =========================================================================

  describe('TaskFailed', () => {
    it('should call scheduler.failJob with error from event data', () => {
      const msg: EventMsg = {
        type: 'TaskFailed',
        data: { error: 'API rate limit exceeded', reason: 'rate_limit' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith(
        'job-123',
        'API rate limit exceeded'
      );
    });

    it('should fall back to reason when error is missing', () => {
      const msg: EventMsg = {
        type: 'TaskFailed',
        data: { reason: 'timeout' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'timeout');
    });

    it('should use default message when both error and reason are missing', () => {
      const msg: EventMsg = {
        type: 'TaskFailed',
        data: {} as any,
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'Job failed');
    });

    it('should clear runningSchedulerJobId and runningJobStartTime', () => {
      const msg: EventMsg = {
        type: 'TaskFailed',
        data: { reason: 'error' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.runningSchedulerJobId).toBeNull();
      expect(state.runningJobStartTime).toBe(0);
    });
  });

  // =========================================================================
  // TurnAborted (task abort/interrupt — previously unhandled, caused stuck jobs)
  // =========================================================================

  describe('TurnAborted', () => {
    it('should call scheduler.failJob with abort reason', () => {
      const msg: EventMsg = {
        type: 'TurnAborted',
        data: { reason: 'user_interrupt', submission_id: 'sub-1', turn_count: 3 },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'user_interrupt');
    });

    it('should handle automatic_abort reason', () => {
      const msg: EventMsg = {
        type: 'TurnAborted',
        data: { reason: 'automatic_abort', submission_id: 'sub-1', turn_count: 10 },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'automatic_abort');
    });

    it('should use default message when reason is missing', () => {
      const msg: EventMsg = {
        type: 'TurnAborted',
        data: {} as any,
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'Job failed');
    });

    it('should clear runningSchedulerJobId and runningJobStartTime', () => {
      const msg: EventMsg = {
        type: 'TurnAborted',
        data: { reason: 'user_interrupt' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.runningSchedulerJobId).toBeNull();
      expect(state.runningJobStartTime).toBe(0);
    });
  });

  // =========================================================================
  // Error (task execution error — previously unhandled, caused stuck jobs)
  // =========================================================================

  describe('Error', () => {
    it('should call scheduler.failJob with error message', () => {
      const msg: EventMsg = {
        type: 'Error',
        data: { message: 'No API key configured for OpenAI' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith(
        'job-123',
        'No API key configured for OpenAI'
      );
    });

    it('should handle task execution failure message', () => {
      const msg: EventMsg = {
        type: 'Error',
        data: { message: 'Task execution failed: connection timeout' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith(
        'job-123',
        'Task execution failed: connection timeout'
      );
    });

    it('should use default message when data is empty', () => {
      const msg: EventMsg = {
        type: 'Error',
        data: {} as any,
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'Job failed');
    });

    it('should clear runningSchedulerJobId and runningJobStartTime', () => {
      const msg: EventMsg = {
        type: 'Error',
        data: { message: 'Something went wrong' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.runningSchedulerJobId).toBeNull();
      expect(state.runningJobStartTime).toBe(0);
    });
  });

  // =========================================================================
  // Guard conditions
  // =========================================================================

  describe('guard conditions', () => {
    it('should do nothing when runningSchedulerJobId is null', () => {
      state.runningSchedulerJobId = null;

      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.completeJob).not.toHaveBeenCalled();
      expect(state.scheduler!.failJob).not.toHaveBeenCalled();
    });

    it('should do nothing when scheduler is null', () => {
      state.scheduler = null;

      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);
      // No crash, no calls
    });

    it('should ignore non-completion events', () => {
      const msg: EventMsg = {
        type: 'AgentMessage',
        data: { content: 'Hello' },
      } as any;

      handleSchedulerEventCompletion(state, msg);

      expect(state.scheduler!.completeJob).not.toHaveBeenCalled();
      expect(state.scheduler!.failJob).not.toHaveBeenCalled();
      // runningSchedulerJobId should NOT be cleared
      expect(state.runningSchedulerJobId).toBe('job-123');
    });

    it('should only handle first completion event (idempotent)', () => {
      const msg: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'Done' },
      };

      handleSchedulerEventCompletion(state, msg);
      handleSchedulerEventCompletion(state, msg); // Second call — jobId is now null

      expect(state.scheduler!.completeJob).toHaveBeenCalledTimes(1);
    });

    it('should not double-fail on TurnAborted followed by Error', () => {
      // TaskRunner error path emits TurnAborted then Error — only first should trigger
      const abortMsg: EventMsg = {
        type: 'TurnAborted',
        data: { reason: 'user_interrupt' },
      };
      const errorMsg: EventMsg = {
        type: 'Error',
        data: { message: 'Task execution failed' },
      };

      handleSchedulerEventCompletion(state, abortMsg);
      handleSchedulerEventCompletion(state, errorMsg); // runningSchedulerJobId already null

      expect(state.scheduler!.failJob).toHaveBeenCalledTimes(1);
      expect(state.scheduler!.failJob).toHaveBeenCalledWith('job-123', 'user_interrupt');
    });
  });
});
