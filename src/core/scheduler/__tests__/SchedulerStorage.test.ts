/**
 * Unit tests for SchedulerStorage
 *
 * Tests cover:
 * - Job CRUD operations (create, get, update, delete)
 * - Query methods (getDraftJobs, getScheduledJobs, getMissedJobs, etc.)
 * - Scheduler state management (getSchedulerState, setSchedulerState)
 * - chrome.storage.local fallback when ConfigStorageProvider is not initialized
 * - Error handling and edge cases
 * - Job counting and UI display helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORE_NAMES, INDEX_NAMES } from '@/storage/IndexedDBAdapter';
import type { IndexedDBAdapter } from '@/storage/IndexedDBAdapter';
import type { SchedulerJobRecord, SchedulerState } from '@/core/models/types/Scheduler';
import { SCHEDULER_STATE_KEY } from '@/core/models/types/SchedulerContracts';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let uuidCounter = 0;
  return {
    uuidv4: vi.fn(() => `test-uuid-${++uuidCounter}`),
    resetUuidCounter: () => { uuidCounter = 0; },
    isConfigStorageInitialized: vi.fn(() => false),
    getConfigStorage: vi.fn(),
  };
});

vi.mock('uuid', () => ({
  v4: mocks.uuidv4,
}));

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: mocks.isConfigStorageInitialized,
  getConfigStorage: mocks.getConfigStorage,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDB(): IndexedDBAdapter {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    getAll: vi.fn().mockResolvedValue([]),
    queryByIndex: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    batchDelete: vi.fn().mockResolvedValue(0),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as IndexedDBAdapter;
}

function makeJob(overrides: Partial<SchedulerJobRecord> = {}): SchedulerJobRecord {
  return {
    id: 'task-1',
    input: 'Test job',
    scheduledTime: null,
    createdAt: 1000,
    status: 'draft',
    sessionId: null,
    completedAt: null,
    error: null,
    result: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { SchedulerStorage } = await import('@/core/scheduler/SchedulerStorage');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerStorage', () => {
  let storage: InstanceType<typeof SchedulerStorage>;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    mocks.resetUuidCounter();
    mocks.isConfigStorageInitialized.mockReturnValue(false);
    mocks.getConfigStorage.mockImplementation(() => {
      throw new Error('Not initialized');
    });
    mockDB = createMockDB();
    storage = new SchedulerStorage(mockDB);
  });

  // =========================================================================
  // createJob
  // =========================================================================
  describe('createJob()', () => {
    it('should create a draft job when no scheduledTime is provided', async () => {
      const job = await storage.createJob('Write a report');

      expect(job.id).toBe('test-uuid-1');
      expect(job.input).toBe('Write a report');
      expect(job.status).toBe('draft');
      expect(job.scheduledTime).toBeNull();
      expect(job.sessionId).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.error).toBeNull();
      expect(job.result).toBeNull();
    });

    it('should create a scheduled job when scheduledTime is provided', async () => {
      const scheduledTime = Date.now() + 60000;
      const job = await storage.createJob('Schedule me', scheduledTime);

      expect(job.id).toBe('test-uuid-1');
      expect(job.input).toBe('Schedule me');
      expect(job.status).toBe('scheduled');
      expect(job.scheduledTime).toBe(scheduledTime);
    });

    it('should persist the job to IndexedDB via db.put', async () => {
      const job = await storage.createJob('Persist me');

      expect(mockDB.put).toHaveBeenCalledTimes(1);
      expect(mockDB.put).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_JOBS, job);
    });

    it('should generate unique IDs for each job', async () => {
      const job1 = await storage.createJob('Job 1');
      const job2 = await storage.createJob('Job 2');

      expect(job1.id).toBe('test-uuid-1');
      expect(job2.id).toBe('test-uuid-2');
      expect(job1.id).not.toBe(job2.id);
    });

    it('should set createdAt to current timestamp for draft jobs', async () => {
      const before = Date.now();
      const job = await storage.createJob('Timestamped');
      const after = Date.now();

      expect(job.createdAt).toBeGreaterThanOrEqual(before);
      expect(job.createdAt).toBeLessThanOrEqual(after);
    });

    it('should set createdAt to current timestamp for scheduled jobs', async () => {
      const before = Date.now();
      const job = await storage.createJob('Scheduled', Date.now() + 60000);
      const after = Date.now();

      expect(job.createdAt).toBeGreaterThanOrEqual(before);
      expect(job.createdAt).toBeLessThanOrEqual(after);
    });

    it('should propagate IndexedDB errors from db.put', async () => {
      (mockDB.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));

      await expect(storage.createJob('Failing')).rejects.toThrow('DB write failed');
    });

    it('should handle empty string input', async () => {
      const job = await storage.createJob('');
      expect(job.input).toBe('');
      expect(job.status).toBe('draft');
    });

    it('should handle very long input strings', async () => {
      const longInput = 'x'.repeat(10000);
      const job = await storage.createJob(longInput);
      expect(job.input).toBe(longInput);
    });
  });

  // =========================================================================
  // getJob
  // =========================================================================
  describe('getJob()', () => {
    it('should return a job when found', async () => {
      const job = makeJob({ id: 'abc-123' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(job);

      const result = await storage.getJob('abc-123');

      expect(result).toEqual(job);
      expect(mockDB.get).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_JOBS, 'abc-123');
    });

    it('should return null when job not found', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await storage.getJob('nonexistent');
      expect(result).toBeNull();
    });

    it('should propagate IndexedDB errors from db.get', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB read failed'));

      await expect(storage.getJob('abc')).rejects.toThrow('DB read failed');
    });
  });

  // =========================================================================
  // updateJob
  // =========================================================================
  describe('updateJob()', () => {
    it('should merge updates into existing job', async () => {
      const existing = makeJob({ id: 'u-1', status: 'draft' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateJob('u-1', { status: 'scheduled', scheduledTime: 9999 });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        expect.objectContaining({
          id: 'u-1',
          status: 'scheduled',
          scheduledTime: 9999,
          input: 'Test job',
        })
      );
    });

    it('should preserve the original ID even if updates try to change it', async () => {
      const existing = makeJob({ id: 'original-id' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateJob('original-id', { id: 'attempted-new-id' } as any);

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        expect.objectContaining({ id: 'original-id' })
      );
    });

    it('should throw when job does not exist', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(storage.updateJob('ghost', { status: 'running' }))
        .rejects.toThrow('Job not found: ghost');
    });

    it('should propagate db.put errors', async () => {
      const existing = makeJob({ id: 'u-2' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (mockDB.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Write error'));

      await expect(storage.updateJob('u-2', { status: 'running' }))
        .rejects.toThrow('Write error');
    });

    it('should allow updating multiple fields at once', async () => {
      const existing = makeJob({ id: 'u-3' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateJob('u-3', {
        status: 'completed',
        completedAt: 5000,
        sessionId: 'session-x',
        result: {
          summary: 'Done',
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          duration: 1500,
        },
      });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        expect.objectContaining({
          status: 'completed',
          completedAt: 5000,
          sessionId: 'session-x',
          result: expect.objectContaining({ summary: 'Done' }),
        })
      );
    });

    it('should allow updating with an error message', async () => {
      const existing = makeJob({ id: 'u-4' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateJob('u-4', {
        status: 'failed',
        error: 'Something went wrong',
      });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        expect.objectContaining({
          status: 'failed',
          error: 'Something went wrong',
        })
      );
    });
  });

  // =========================================================================
  // deleteJob
  // =========================================================================
  describe('deleteJob()', () => {
    it('should call db.delete with the correct store and key', async () => {
      await storage.deleteJob('del-1');

      expect(mockDB.delete).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_JOBS, 'del-1');
    });

    it('should not throw when deleting a nonexistent job', async () => {
      (mockDB.delete as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(storage.deleteJob('nonexistent')).resolves.toBeUndefined();
    });

    it('should propagate db.delete errors', async () => {
      (mockDB.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Delete failed'));

      await expect(storage.deleteJob('del-2')).rejects.toThrow('Delete failed');
    });
  });

  // =========================================================================
  // getDraftJobs
  // =========================================================================
  describe('getDraftJobs()', () => {
    it('should query by status index with "draft"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getDraftJobs();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'draft'
      );
    });

    it('should sort drafts by createdAt ascending', async () => {
      const tasks = [
        makeJob({ id: 'd-3', createdAt: 3000, status: 'draft' }),
        makeJob({ id: 'd-1', createdAt: 1000, status: 'draft' }),
        makeJob({ id: 'd-2', createdAt: 2000, status: 'draft' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getDraftJobs();

      expect(result.map(t => t.id)).toEqual(['d-1', 'd-2', 'd-3']);
    });

    it('should return empty array when no drafts exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getDraftJobs();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getScheduledJobs
  // =========================================================================
  describe('getScheduledJobs()', () => {
    it('should query by status index with "scheduled"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getScheduledJobs();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'scheduled'
      );
    });

    it('should sort scheduled jobs by scheduledTime ascending', async () => {
      const tasks = [
        makeJob({ id: 's-3', scheduledTime: 3000, status: 'scheduled' }),
        makeJob({ id: 's-1', scheduledTime: 1000, status: 'scheduled' }),
        makeJob({ id: 's-2', scheduledTime: 2000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getScheduledJobs();

      expect(result.map(t => t.id)).toEqual(['s-1', 's-2', 's-3']);
    });

    it('should handle jobs with null scheduledTime (treated as 0)', async () => {
      const tasks = [
        makeJob({ id: 's-2', scheduledTime: 2000, status: 'scheduled' }),
        makeJob({ id: 's-null', scheduledTime: null, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getScheduledJobs();

      expect(result[0].id).toBe('s-null');
      expect(result[1].id).toBe('s-2');
    });

    it('should return empty array when none scheduled', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getScheduledJobs();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getMissedJobs
  // =========================================================================
  describe('getMissedJobs()', () => {
    it('should query by status index with "missed"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getMissedJobs();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'missed'
      );
    });

    it('should sort missed jobs by scheduledTime ascending', async () => {
      const tasks = [
        makeJob({ id: 'm-2', scheduledTime: 2000, status: 'missed' }),
        makeJob({ id: 'm-1', scheduledTime: 1000, status: 'missed' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getMissedJobs();

      expect(result.map(t => t.id)).toEqual(['m-1', 'm-2']);
    });

    it('should return empty array when no missed jobs', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getMissedJobs();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getJobQueueJobs
  // =========================================================================
  describe('getJobQueueJobs()', () => {
    it('should query by status index with "waiting"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getJobQueueJobs();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'waiting'
      );
    });

    it('should sort waiting jobs by createdAt (FIFO)', async () => {
      const tasks = [
        makeJob({ id: 'w-3', createdAt: 3000, status: 'waiting' }),
        makeJob({ id: 'w-1', createdAt: 1000, status: 'waiting' }),
        makeJob({ id: 'w-2', createdAt: 2000, status: 'waiting' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getJobQueueJobs();

      expect(result.map(t => t.id)).toEqual(['w-1', 'w-2', 'w-3']);
    });

    it('should return empty array when queue is empty', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getJobQueueJobs();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getArchivedJobs
  // =========================================================================
  describe('getArchivedJobs()', () => {
    it('should query completed, failed, and cancelled statuses', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getArchivedJobs(10, 0);

      expect(mockDB.queryByIndex).toHaveBeenCalledTimes(3);
      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'completed'
      );
      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'failed'
      );
      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'cancelled'
      );
    });

    it('should sort archived jobs by completedAt descending (most recent first)', async () => {
      const completed = [
        makeJob({ id: 'c-1', status: 'completed', completedAt: 1000 }),
        makeJob({ id: 'c-3', status: 'completed', completedAt: 3000 }),
      ];
      const failed = [
        makeJob({ id: 'f-2', status: 'failed', completedAt: 2000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce(failed);

      const result = await storage.getArchivedJobs(10, 0);

      expect(result.map(t => t.id)).toEqual(['c-3', 'f-2', 'c-1']);
    });

    it('should apply pagination with limit and offset', async () => {
      const completed = [
        makeJob({ id: 'c-1', status: 'completed', completedAt: 1000 }),
        makeJob({ id: 'c-2', status: 'completed', completedAt: 2000 }),
        makeJob({ id: 'c-3', status: 'completed', completedAt: 3000 }),
        makeJob({ id: 'c-4', status: 'completed', completedAt: 4000 }),
        makeJob({ id: 'c-5', status: 'completed', completedAt: 5000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      // offset=1, limit=2 -> skip the first (c-5), take next 2 (c-4, c-3)
      const result = await storage.getArchivedJobs(2, 1);

      expect(result.map(t => t.id)).toEqual(['c-4', 'c-3']);
    });

    it('should return empty array when no archived jobs', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedJobs(10, 0);
      expect(result).toEqual([]);
    });

    it('should handle offset beyond available jobs', async () => {
      const completed = [makeJob({ id: 'c-1', status: 'completed', completedAt: 1000 })];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedJobs(10, 100);
      expect(result).toEqual([]);
    });

    it('should handle null completedAt values (treated as 0)', async () => {
      const completed = [
        makeJob({ id: 'c-null', status: 'completed', completedAt: null }),
        makeJob({ id: 'c-2', status: 'completed', completedAt: 2000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedJobs(10, 0);

      // c-2 (2000) comes before c-null (0) in descending order
      expect(result[0].id).toBe('c-2');
      expect(result[1].id).toBe('c-null');
    });
  });

  // =========================================================================
  // getNextJobInQueue
  // =========================================================================
  describe('getNextJobInQueue()', () => {
    it('should return the first job in FIFO order', async () => {
      const tasks = [
        makeJob({ id: 'w-2', createdAt: 2000, status: 'waiting' }),
        makeJob({ id: 'w-1', createdAt: 1000, status: 'waiting' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getNextJobInQueue();

      expect(result).not.toBeNull();
      expect(result!.id).toBe('w-1');
    });

    it('should return null when queue is empty', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getNextJobInQueue();
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // getOverdueScheduledJobs
  // =========================================================================
  describe('getOverdueScheduledJobs()', () => {
    it('should return jobs with scheduledTime in the past', async () => {
      const now = Date.now();
      const tasks = [
        makeJob({ id: 'o-1', scheduledTime: now - 10000, status: 'scheduled' }),
        makeJob({ id: 'o-future', scheduledTime: now + 60000, status: 'scheduled' }),
        makeJob({ id: 'o-2', scheduledTime: now - 5000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledJobs();

      expect(result.map(t => t.id)).toEqual(['o-1', 'o-2']);
    });

    it('should return empty array when no jobs are overdue', async () => {
      const now = Date.now();
      const tasks = [
        makeJob({ id: 's-1', scheduledTime: now + 60000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledJobs();
      expect(result).toEqual([]);
    });

    it('should exclude jobs with null scheduledTime', async () => {
      const tasks = [
        makeJob({ id: 's-null', scheduledTime: null, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledJobs();
      expect(result).toEqual([]);
    });

    it('should return empty array when no scheduled jobs exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getOverdueScheduledJobs();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getCurrentJob
  // =========================================================================
  describe('getCurrentJob()', () => {
    it('should query by status index with "running"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getCurrentJob();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'running'
      );
    });

    it('should return the running job', async () => {
      const runningTask = makeJob({ id: 'r-1', status: 'running' });
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([runningTask]);

      const result = await storage.getCurrentJob();
      expect(result).toEqual(runningTask);
    });

    it('should return null when no running job', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getCurrentJob();
      expect(result).toBeNull();
    });

    it('should return only the first running job if multiple exist', async () => {
      const tasks = [
        makeJob({ id: 'r-1', status: 'running' }),
        makeJob({ id: 'r-2', status: 'running' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getCurrentJob();
      expect(result!.id).toBe('r-1');
    });
  });

  // =========================================================================
  // countByStatus
  // =========================================================================
  describe('countByStatus()', () => {
    it('should return count of jobs with the given status', async () => {
      const tasks = [
        makeJob({ id: 'd-1', status: 'draft' }),
        makeJob({ id: 'd-2', status: 'draft' }),
        makeJob({ id: 'd-3', status: 'draft' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const count = await storage.countByStatus('draft');
      expect(count).toBe(3);
    });

    it('should return 0 when no jobs match', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const count = await storage.countByStatus('running');
      expect(count).toBe(0);
    });

    it('should use the correct store and index', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.countByStatus('waiting');

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_JOBS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'waiting'
      );
    });
  });

  // =========================================================================
  // getJobCounts
  // =========================================================================
  describe('getJobCounts()', () => {
    it('should return counts for all relevant statuses', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([makeJob()])                         // draft
        .mockResolvedValueOnce([makeJob(), makeJob()])             // scheduled
        .mockResolvedValueOnce([])                                   // missed
        .mockResolvedValueOnce([makeJob(), makeJob(), makeJob()]) // waiting
        .mockResolvedValueOnce([makeJob()]);                        // running

      const counts = await storage.getJobCounts();

      expect(counts).toEqual({
        draftCount: 1,
        scheduledCount: 2,
        missedCount: 0,
        waitingCount: 3,
        runningCount: 1,
      });
    });

    it('should return all zeros when no tasks exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const counts = await storage.getJobCounts();

      expect(counts).toEqual({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 0,
      });
    });

    it('should query all five statuses in parallel', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getJobCounts();

      expect(mockDB.queryByIndex).toHaveBeenCalledTimes(5);
      const statusArgs = (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: any[]) => c[2]
      );
      expect(statusArgs).toContain('draft');
      expect(statusArgs).toContain('scheduled');
      expect(statusArgs).toContain('missed');
      expect(statusArgs).toContain('waiting');
      expect(statusArgs).toContain('running');
    });
  });

  // =========================================================================
  // getSchedulerState - with chrome.storage.local fallback
  // =========================================================================
  describe('getSchedulerState()', () => {
    it('should return default state when storage is not available', async () => {
      // Make chrome undefined temporarily
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 0,
      });

      (globalThis as any).chrome = origChrome;
    });

    it('should return default state when ConfigStorageProvider is not initialized and chrome is unavailable', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 0,
      });

      (globalThis as any).chrome = origChrome;
    });

    it('should use chrome.storage.local fallback when ConfigStorageProvider not initialized', async () => {
      // Pre-populate chrome.storage.local with scheduler state
      const customState: SchedulerState = {
        isPaused: true,
        currentJobId: 'task-abc',
        lastProcessedTime: 12345,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: customState });

      const state = await storage.getSchedulerState();

      expect(state).toEqual(customState);
    });

    it('should return default state when chrome.storage.local has no data', async () => {
      // chrome.storage.local is empty (setup.ts resets it)
      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 0,
      });
    });

    it('should use ConfigStorageProvider when initialized', async () => {
      const customState: SchedulerState = {
        isPaused: true,
        currentJobId: 'task-xyz',
        lastProcessedTime: 99999,
      };
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue(customState),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const state = await storage.getSchedulerState();

      expect(state).toEqual(customState);
      expect(mockConfigStorage.get).toHaveBeenCalledWith(SCHEDULER_STATE_KEY);
    });

    it('should return default state when ConfigStorageProvider.get returns null', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 0,
      });
    });

    it('should return default state and log warning on storage error', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage broke')),
        set: vi.fn(),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 0,
      });
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // setSchedulerState
  // =========================================================================
  describe('setSchedulerState()', () => {
    it('should throw when no storage is available', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      await expect(storage.setSchedulerState({ isPaused: true }))
        .rejects.toThrow('Storage not available');

      (globalThis as any).chrome = origChrome;
    });

    it('should merge partial state with current state using chrome.storage.local', async () => {
      // Pre-populate with existing state
      const existingState: SchedulerState = {
        isPaused: false,
        currentJobId: 'task-1',
        lastProcessedTime: 100,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: existingState });

      await storage.setSchedulerState({ isPaused: true });

      // Read back from chrome storage
      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual({
        isPaused: true,
        currentJobId: 'task-1',
        lastProcessedTime: 100,
      });
    });

    it('should update only the currentJobId', async () => {
      const existingState: SchedulerState = {
        isPaused: false,
        currentJobId: null,
        lastProcessedTime: 200,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: existingState });

      await storage.setSchedulerState({ currentJobId: 'new-task' });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual({
        isPaused: false,
        currentJobId: 'new-task',
        lastProcessedTime: 200,
      });
    });

    it('should update lastProcessedTime', async () => {
      await storage.setSchedulerState({ lastProcessedTime: 5000 });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual(
        expect.objectContaining({ lastProcessedTime: 5000 })
      );
    });

    it('should use ConfigStorageProvider when initialized', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue({
          isPaused: false,
          currentJobId: null,
          lastProcessedTime: 0,
        }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      await storage.setSchedulerState({ isPaused: true });

      expect(mockConfigStorage.set).toHaveBeenCalledWith(
        SCHEDULER_STATE_KEY,
        expect.objectContaining({ isPaused: true })
      );
    });

    it('should handle chrome.storage.local.set errors via runtime.lastError', async () => {
      // This exercises the fallback path error handling.
      // The mock storage checks for quota errors, but normally runtime.lastError
      // won't be set for simple operations. We just verify no crash.
      await storage.setSchedulerState({ isPaused: false });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual(
        expect.objectContaining({ isPaused: false })
      );
    });
  });

  // =========================================================================
  // getStorage (private) - chrome.storage.local fallback behavior
  // =========================================================================
  describe('getStorage() private method - chrome.storage.local fallback', () => {
    it('should return a ConfigStorageProvider-compatible object from chrome.storage.local', async () => {
      // Access private method
      const storageProvider = await (storage as any).getStorage();

      expect(storageProvider).not.toBeNull();
      expect(typeof storageProvider.get).toBe('function');
      expect(typeof storageProvider.set).toBe('function');
      expect(typeof storageProvider.remove).toBe('function');
      expect(typeof storageProvider.getMany).toBe('function');
      expect(typeof storageProvider.setMany).toBe('function');
      expect(typeof storageProvider.removeMany).toBe('function');
      expect(typeof storageProvider.getAll).toBe('function');
      expect(typeof storageProvider.clear).toBe('function');
      expect(typeof storageProvider.getBytesInUse).toBe('function');
    });

    it('fallback get should return value from chrome.storage.local', async () => {
      await chrome.storage.local.set({ testKey: 'testValue' });

      const storageProvider = await (storage as any).getStorage();
      const value = await storageProvider.get('testKey');

      expect(value).toBe('testValue');
    });

    it('fallback get should return null for missing key', async () => {
      const storageProvider = await (storage as any).getStorage();
      const value = await storageProvider.get('missing');

      expect(value).toBeNull();
    });

    it('fallback set should write to chrome.storage.local', async () => {
      const storageProvider = await (storage as any).getStorage();
      await storageProvider.set('key1', 'value1');

      const result = await chrome.storage.local.get('key1');
      expect(result.key1).toBe('value1');
    });

    it('fallback remove should delete from chrome.storage.local', async () => {
      await chrome.storage.local.set({ removeMe: 'data' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.remove('removeMe');

      const result = await chrome.storage.local.get('removeMe');
      expect(result.removeMe).toBeUndefined();
    });

    it('fallback getMany should return multiple values', async () => {
      await chrome.storage.local.set({ a: 1, b: 2, c: 3 });

      const storageProvider = await (storage as any).getStorage();
      const values = await storageProvider.getMany(['a', 'c']);

      expect(values).toEqual({ a: 1, c: 3 });
    });

    it('fallback setMany should write multiple values', async () => {
      const storageProvider = await (storage as any).getStorage();
      await storageProvider.setMany({ x: 10, y: 20 });

      const result = await chrome.storage.local.get(['x', 'y']);
      expect(result).toEqual({ x: 10, y: 20 });
    });

    it('fallback removeMany should delete multiple keys', async () => {
      await chrome.storage.local.set({ r1: 'a', r2: 'b', keep: 'c' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.removeMany(['r1', 'r2']);

      const result = await chrome.storage.local.get(['r1', 'r2', 'keep']);
      expect(result.r1).toBeUndefined();
      expect(result.r2).toBeUndefined();
      expect(result.keep).toBe('c');
    });

    it('fallback getAll should return all stored data', async () => {
      await chrome.storage.local.set({ all1: 'x', all2: 'y' });

      const storageProvider = await (storage as any).getStorage();
      const all = await storageProvider.getAll();

      expect(all).toEqual({ all1: 'x', all2: 'y' });
    });

    it('fallback clear should remove all data', async () => {
      await chrome.storage.local.set({ clearMe: 'data' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.clear();

      const result = await chrome.storage.local.get(null);
      expect(result).toEqual({});
    });

    it('fallback getBytesInUse should return null', async () => {
      const storageProvider = await (storage as any).getStorage();
      const bytes = await storageProvider.getBytesInUse();

      expect(bytes).toBeNull();
    });

    it('should return null when chrome is undefined', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const result = await (storage as any).getStorage();
      expect(result).toBeNull();

      (globalThis as any).chrome = origChrome;
    });

    it('should return null when chrome.storage is undefined', async () => {
      const origStorage = chrome.storage;
      (chrome as any).storage = undefined;

      const result = await (storage as any).getStorage();
      expect(result).toBeNull();

      (chrome as any).storage = origStorage;
    });
  });
});
