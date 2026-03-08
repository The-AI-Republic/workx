/**
 * Tests for JobExecutor
 *
 * Tests execution lifecycle, queue management, session handling, and recovery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobExecutor } from '../JobExecutor';
import type { IExecutionStorage } from '../../models/types/ScheduleContracts';
import type { ExecutionRecord } from '../../models/types/ScheduleEvent';
import type { JobResultRecord } from '../../models/types/Scheduler';

// Mock uuid
const mockUuid = vi.hoisted(() => vi.fn(() => 'mock-exec-uuid'));
vi.mock('uuid', () => ({ v4: mockUuid }));

function createMockExecutionStorage(): IExecutionStorage {
  return {
    createExecution: vi.fn(),
    getExecution: vi.fn(),
    updateExecution: vi.fn(),
    deleteExecution: vi.fn(),
    getExecutionsByEvent: vi.fn().mockResolvedValue([]),
    getExecutionByInstance: vi.fn().mockResolvedValue(null),
    getExecutionsByStatus: vi.fn().mockResolvedValue([]),
    getExecutionsInRange: vi.fn().mockResolvedValue([]),
    getLatestExecution: vi.fn().mockResolvedValue(null),
    getRunningExecutions: vi.fn().mockResolvedValue([]),
    getArchivedExecutions: vi.fn().mockResolvedValue([]),
    getArchivedExecutionsCount: vi.fn().mockResolvedValue(0),
  };
}

function createTestExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    scheduleEventId: 'event-1',
    instanceTime: Date.now(),
    input: 'Test input',
    sessionId: null,
    status: 'running',
    result: null,
    error: null,
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

describe('JobExecutor', () => {
  let executor: JobExecutor;
  let executionStorage: ReturnType<typeof createMockExecutionStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    executionStorage = createMockExecutionStorage();
    executor = new JobExecutor(executionStorage);
    mockUuid.mockReturnValue('mock-exec-uuid');
  });

  describe('execute', () => {
    it('should create execution record and launch job', async () => {
      const launcher = vi.fn();
      executor.setJobLauncher(launcher);

      const executionId = await executor.execute('event-1', Date.now(), 'Test input');

      expect(executionId).toBe('mock-exec-uuid');
      expect(executionStorage.createExecution).toHaveBeenCalledOnce();
      expect(launcher).toHaveBeenCalledOnce();
    });

    it('should guard against concurrent triggers of same instance', async () => {
      const launcher = vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 100)));
      executor.setJobLauncher(launcher);

      const time = Date.now();
      const p1 = executor.execute('event-1', time, 'Test');

      await expect(
        executor.execute('event-1', time, 'Test')
      ).rejects.toThrow('Execution already in progress');

      await p1;
    });
  });

  describe('completeExecution', () => {
    it('should mark execution as completed', async () => {
      const execution = createTestExecution();
      (executionStorage.getExecution as any).mockResolvedValue(execution);

      const result: JobResultRecord = {
        summary: 'Done',
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        duration: 5000,
      };

      await executor.completeExecution('exec-1', result);

      expect(executionStorage.updateExecution).toHaveBeenCalledWith('exec-1', {
        status: 'completed',
        result,
        completedAt: expect.any(Number),
      });
    });

    it('should call execution complete handler', async () => {
      const handler = vi.fn();
      executor.setExecutionCompleteHandler(handler);

      const execution = createTestExecution();
      (executionStorage.getExecution as any).mockResolvedValue(execution);

      await executor.completeExecution('exec-1', {
        summary: 'Done',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        duration: 0,
      });

      expect(handler).toHaveBeenCalledWith('event-1');
    });

    it('should throw for non-running execution', async () => {
      (executionStorage.getExecution as any).mockResolvedValue(
        createTestExecution({ status: 'completed' })
      );

      await expect(
        executor.completeExecution('exec-1', {
          summary: 'Done',
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          duration: 0,
        })
      ).rejects.toThrow('Cannot complete execution in completed status');
    });
  });

  describe('failExecution', () => {
    it('should mark execution as failed', async () => {
      const execution = createTestExecution();
      (executionStorage.getExecution as any).mockResolvedValue(execution);

      await executor.failExecution('exec-1', 'Something went wrong');

      expect(executionStorage.updateExecution).toHaveBeenCalledWith('exec-1', {
        status: 'failed',
        error: 'Something went wrong',
        completedAt: expect.any(Number),
      });
    });
  });

  describe('cancelExecution', () => {
    it('should cancel a running execution', async () => {
      const execution = createTestExecution();
      (executionStorage.getExecution as any).mockResolvedValue(execution);

      await executor.cancelExecution('exec-1');

      expect(executionStorage.updateExecution).toHaveBeenCalledWith('exec-1', {
        status: 'cancelled',
        completedAt: expect.any(Number),
      });
    });

    it('should cancel a pending execution', async () => {
      (executionStorage.getExecution as any).mockResolvedValue(
        createTestExecution({ status: 'pending' })
      );

      await executor.cancelExecution('exec-1');

      expect(executionStorage.updateExecution).toHaveBeenCalledWith('exec-1', {
        status: 'cancelled',
        completedAt: expect.any(Number),
      });
    });

    it('should throw for completed execution', async () => {
      (executionStorage.getExecution as any).mockResolvedValue(
        createTestExecution({ status: 'completed' })
      );

      await expect(
        executor.cancelExecution('exec-1')
      ).rejects.toThrow('Cannot cancel execution in completed status');
    });
  });

  describe('recoverStaleExecutions', () => {
    it('should mark all running executions as failed', async () => {
      const staleExecs = [
        createTestExecution({ id: 'stale-1' }),
        createTestExecution({ id: 'stale-2' }),
      ];
      (executionStorage.getRunningExecutions as any).mockResolvedValue(staleExecs);

      await executor.recoverStaleExecutions();

      expect(executionStorage.updateExecution).toHaveBeenCalledTimes(2);
      expect(executionStorage.updateExecution).toHaveBeenCalledWith('stale-1', {
        status: 'failed',
        error: expect.stringContaining('interrupted'),
        completedAt: expect.any(Number),
      });
    });

    it('should do nothing if no stale executions', async () => {
      (executionStorage.getRunningExecutions as any).mockResolvedValue([]);

      await executor.recoverStaleExecutions();

      expect(executionStorage.updateExecution).not.toHaveBeenCalled();
    });
  });

  describe('getExecutionHistory', () => {
    it('should return executions for an event', async () => {
      const executions = [createTestExecution()];
      (executionStorage.getExecutionsByEvent as any).mockResolvedValue(executions);

      const result = await executor.getExecutionHistory('event-1');

      expect(result).toEqual(executions);
      expect(executionStorage.getExecutionsByEvent).toHaveBeenCalledWith('event-1');
    });
  });

  describe('isOnline', () => {
    it('should return true by default', () => {
      expect(executor.isOnline()).toBe(true);
    });

    it('should respect connectivity check', () => {
      executor.setConnectivityCheck(() => false);
      expect(executor.isOnline()).toBe(false);
    });
  });

  describe('execute queuing', () => {
    it('should queue as pending when isExecuting is true', async () => {
      const launcher = vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 100)));
      executor.setJobLauncher(launcher);

      // Start first execution
      const p1 = executor.execute('event-1', Date.now(), 'First');

      // Second execute for a different instance should queue (isExecuting is true)
      const id2 = await executor.execute('event-2', Date.now() + 1000, 'Second');

      expect(id2).toBe('mock-exec-uuid');
      expect(executionStorage.createExecution).toHaveBeenCalledTimes(2);
      // Second call should create a pending record with input preserved
      const secondCall = (executionStorage.createExecution as any).mock.calls[1][0];
      expect(secondCall.status).toBe('pending');
      expect(secondCall.input).toBe('Second');

      await p1;
    });
  });

  describe('processQueue', () => {
    it('should process pending executions in FIFO order', async () => {
      const pending = [
        createTestExecution({ id: 'p2', status: 'pending', instanceTime: Date.now() + 2000, input: 'Second' }),
        createTestExecution({ id: 'p1', status: 'pending', instanceTime: Date.now() + 1000, input: 'First' }),
      ];
      (executionStorage.getExecutionsByStatus as any).mockResolvedValue(pending);

      await executor.processQueue();

      // Should pick the earlier instanceTime (p1)
      expect(executionStorage.updateExecution).toHaveBeenCalledWith('p1', expect.objectContaining({
        status: 'running',
      }));
    });

    it('should not process when offline', async () => {
      executor.setConnectivityCheck(() => false);
      await executor.processQueue();
      expect(executionStorage.getExecutionsByStatus).not.toHaveBeenCalled();
    });

    it('should not process when paused', async () => {
      executor.pauseQueue();
      await executor.processQueue();
      expect(executionStorage.getExecutionsByStatus).not.toHaveBeenCalled();
    });
  });

  describe('pause/resume', () => {
    it('should start unpaused', () => {
      expect(executor.getPauseState()).toBe(false);
    });

    it('should pause the queue', () => {
      executor.pauseQueue();
      expect(executor.getPauseState()).toBe(true);
    });

    it('should resume the queue', () => {
      executor.pauseQueue();
      executor.resumeQueue();
      expect(executor.getPauseState()).toBe(false);
    });
  });

  describe('event emission', () => {
    it('should emit events on status changes', async () => {
      const emitter = vi.fn();
      executor.setEventEmitter(emitter);

      const execution = createTestExecution();
      (executionStorage.getExecution as any).mockResolvedValue(execution);

      await executor.completeExecution('exec-1', {
        summary: 'Done',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        duration: 0,
      });

      expect(emitter).toHaveBeenCalledWith({
        executionId: 'exec-1',
        scheduleEventId: 'event-1',
        status: 'completed',
        timestamp: expect.any(Number),
      });
    });
  });
});
