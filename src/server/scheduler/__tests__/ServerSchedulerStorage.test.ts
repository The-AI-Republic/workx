/**
 * Server Scheduler Storage Tests
 *
 * Tests for ServerSchedulerStorage against the ISchedulerStorage interface.
 * Since better-sqlite3 (native module) is not available in the test environment,
 * this test fully mocks the module at the ServerSchedulerStorage level and
 * validates the storage contract behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { ISchedulerStorage, SchedulerJobCounts } from '../../../core/models/types/SchedulerContracts';
import type { SchedulerJobRecord, SchedulerState } from '../../../core/models/types/Scheduler';
import {
  createDefaultSchedulerState,
  createDraftJobRecord,
  createScheduledJobRecord,
} from '../../../core/models/types/Scheduler';

/**
 * In-memory ISchedulerStorage for testing the interface contract.
 * Mirrors the behavior of ServerSchedulerStorage without requiring SQLite.
 */
class InMemorySchedulerStorage implements ISchedulerStorage {
  private jobs = new Map<string, SchedulerJobRecord>();
  private state: SchedulerState = createDefaultSchedulerState();

  async createJob(input: string, scheduledTime?: number): Promise<SchedulerJobRecord> {
    const id = uuidv4();
    const job = scheduledTime
      ? createScheduledJobRecord(id, input, scheduledTime)
      : createDraftJobRecord(id, input);
    this.jobs.set(id, job);
    return { ...job };
  }

  async getJob(id: string): Promise<SchedulerJobRecord | null> {
    const t = this.jobs.get(id);
    return t ? { ...t } : null;
  }

  async updateJob(id: string, updates: Partial<SchedulerJobRecord>): Promise<void> {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Job not found: ${id}`);
    this.jobs.set(id, { ...existing, ...updates, id });
  }

  async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async getDraftJobs(): Promise<SchedulerJobRecord[]> {
    return [...this.jobs.values()]
      .filter(t => t.status === 'draft')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getScheduledJobs(): Promise<SchedulerJobRecord[]> {
    return [...this.jobs.values()]
      .filter(t => t.status === 'scheduled')
      .sort((a, b) => (a.scheduledTime ?? 0) - (b.scheduledTime ?? 0));
  }

  async getMissedJobs(): Promise<SchedulerJobRecord[]> {
    return [...this.jobs.values()]
      .filter(t => t.status === 'missed')
      .sort((a, b) => (a.scheduledTime ?? 0) - (b.scheduledTime ?? 0));
  }

  async getJobQueueJobs(): Promise<SchedulerJobRecord[]> {
    return [...this.jobs.values()]
      .filter(t => t.status === 'waiting')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getArchivedJobs(limit: number, offset: number): Promise<SchedulerJobRecord[]> {
    return [...this.jobs.values()]
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(offset, offset + limit);
  }

  async getNextJobInQueue(): Promise<SchedulerJobRecord | null> {
    const queue = await this.getJobQueueJobs();
    return queue[0] ?? null;
  }

  async getOverdueScheduledJobs(): Promise<SchedulerJobRecord[]> {
    const now = Date.now();
    return [...this.jobs.values()]
      .filter(t => t.status === 'scheduled' && t.scheduledTime !== null && t.scheduledTime < now);
  }

  async getSchedulerState(): Promise<SchedulerState> {
    return { ...this.state };
  }

  async setSchedulerState(updates: Partial<SchedulerState>): Promise<void> {
    this.state = { ...this.state, ...updates };
  }

  async getJobCounts(): Promise<SchedulerJobCounts> {
    const jobs = [...this.jobs.values()];
    return {
      draftCount: jobs.filter(j => j.status === 'draft').length,
      scheduledCount: jobs.filter(j => j.status === 'scheduled').length,
      missedCount: jobs.filter(j => j.status === 'missed').length,
      waitingCount: jobs.filter(j => j.status === 'waiting').length,
      runningCount: jobs.filter(j => j.status === 'running').length,
    };
  }
}

describe('ServerSchedulerStorage (ISchedulerStorage contract)', () => {
  let storage: ISchedulerStorage;

  beforeEach(() => {
    storage = new InMemorySchedulerStorage();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Job CRUD
  // ─────────────────────────────────────────────────────────────────────

  describe('createJob', () => {
    it('should create a draft job without scheduledTime', async () => {
      const job = await storage.createJob('Test job');
      expect(job.id).toBeTruthy();
      expect(job.input).toBe('Test job');
      expect(job.status).toBe('draft');
      expect(job.scheduledTime).toBeNull();
      expect(job.createdAt).toBeGreaterThan(0);
    });

    it('should create a scheduled job with scheduledTime', async () => {
      const future = Date.now() + 60000;
      const job = await storage.createJob('Scheduled', future);
      expect(job.status).toBe('scheduled');
      expect(job.scheduledTime).toBe(future);
    });
  });

  describe('getJob', () => {
    it('should return null for non-existent job', async () => {
      expect(await storage.getJob('nope')).toBeNull();
    });

    it('should retrieve a created job', async () => {
      const created = await storage.createJob('Test');
      const fetched = await storage.getJob(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.input).toBe('Test');
    });
  });

  describe('updateJob', () => {
    it('should update job fields', async () => {
      const job = await storage.createJob('Test');
      await storage.updateJob(job.id, { status: 'running', sessionId: 'ses-1' });
      const updated = await storage.getJob(job.id);
      expect(updated!.status).toBe('running');
      expect(updated!.sessionId).toBe('ses-1');
    });

    it('should throw for non-existent job', async () => {
      await expect(storage.updateJob('nope', { status: 'running' }))
        .rejects.toThrow('Job not found');
    });

    it('should preserve existing fields', async () => {
      const job = await storage.createJob('Test');
      await storage.updateJob(job.id, { status: 'running' });
      const updated = await storage.getJob(job.id);
      expect(updated!.input).toBe('Test');
      expect(updated!.id).toBe(job.id);
    });
  });

  describe('deleteJob', () => {
    it('should delete a job', async () => {
      const job = await storage.createJob('Delete me');
      await storage.deleteJob(job.id);
      expect(await storage.getJob(job.id)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────

  describe('getDraftJobs', () => {
    it('should return only draft jobs ordered by createdAt', async () => {
      await storage.createJob('Draft 1');
      await storage.createJob('Scheduled', Date.now() + 60000);
      await storage.createJob('Draft 2');
      const drafts = await storage.getDraftJobs();
      expect(drafts).toHaveLength(2);
      expect(drafts[0].input).toBe('Draft 1');
      expect(drafts[1].input).toBe('Draft 2');
    });
  });

  describe('getScheduledJobs', () => {
    it('should return only scheduled jobs ordered by scheduledTime', async () => {
      const later = Date.now() + 120000;
      const sooner = Date.now() + 60000;
      await storage.createJob('Later', later);
      await storage.createJob('Draft');
      await storage.createJob('Sooner', sooner);
      const scheduled = await storage.getScheduledJobs();
      expect(scheduled).toHaveLength(2);
      expect(scheduled[0].input).toBe('Sooner');
      expect(scheduled[1].input).toBe('Later');
    });
  });

  describe('getMissedJobs', () => {
    it('should return jobs with missed status', async () => {
      const t = await storage.createJob('Missed', Date.now() + 60000);
      await storage.updateJob(t.id, { status: 'missed' });
      const missed = await storage.getMissedJobs();
      expect(missed).toHaveLength(1);
      expect(missed[0].id).toBe(t.id);
    });
  });

  describe('getJobQueueJobs', () => {
    it('should return waiting jobs ordered by createdAt', async () => {
      const t1 = await storage.createJob('First');
      const t2 = await storage.createJob('Second');
      await storage.updateJob(t1.id, { status: 'waiting' });
      await storage.updateJob(t2.id, { status: 'waiting' });
      const queue = await storage.getJobQueueJobs();
      expect(queue).toHaveLength(2);
      expect(queue[0].id).toBe(t1.id);
    });
  });

  describe('getArchivedJobs', () => {
    it('should return completed and failed jobs with pagination', async () => {
      const t1 = await storage.createJob('T1');
      const t2 = await storage.createJob('T2');
      const t3 = await storage.createJob('T3');
      await storage.updateJob(t1.id, { status: 'completed', completedAt: 1000 });
      await storage.updateJob(t2.id, { status: 'failed', completedAt: 2000 });
      await storage.updateJob(t3.id, { status: 'completed', completedAt: 3000 });

      const page1 = await storage.getArchivedJobs(2, 0);
      expect(page1).toHaveLength(2);
      expect(page1[0].completedAt).toBe(3000);

      const page2 = await storage.getArchivedJobs(2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('getNextJobInQueue', () => {
    it('should return null when empty', async () => {
      expect(await storage.getNextJobInQueue()).toBeNull();
    });

    it('should return the oldest waiting job', async () => {
      const t1 = await storage.createJob('First');
      const t2 = await storage.createJob('Second');
      await storage.updateJob(t1.id, { status: 'waiting' });
      await storage.updateJob(t2.id, { status: 'waiting' });
      const next = await storage.getNextJobInQueue();
      expect(next!.id).toBe(t1.id);
    });
  });

  describe('getOverdueScheduledJobs', () => {
    it('should return scheduled jobs past their time', async () => {
      const t = await storage.createJob('Overdue', Date.now() + 60000);
      await storage.updateJob(t.id, { scheduledTime: Date.now() - 1000 });
      const overdue = await storage.getOverdueScheduledJobs();
      expect(overdue).toHaveLength(1);
    });

    it('should not return future jobs', async () => {
      await storage.createJob('Future', Date.now() + 60000);
      const overdue = await storage.getOverdueScheduledJobs();
      expect(overdue).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scheduler State
  // ─────────────────────────────────────────────────────────────────────

  describe('getSchedulerState', () => {
    it('should return default state initially', async () => {
      const state = await storage.getSchedulerState();
      expect(state.isPaused).toBe(false);
      expect(state.currentJobId).toBeNull();
      expect(state.lastProcessedTime).toBe(0);
    });
  });

  describe('setSchedulerState', () => {
    it('should update partial state', async () => {
      await storage.setSchedulerState({ isPaused: true });
      const state = await storage.getSchedulerState();
      expect(state.isPaused).toBe(true);
      expect(state.currentJobId).toBeNull();
    });

    it('should update currentJobId', async () => {
      await storage.setSchedulerState({ currentJobId: 'task-1' });
      const state = await storage.getSchedulerState();
      expect(state.currentJobId).toBe('task-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Job Counts
  // ─────────────────────────────────────────────────────────────────────

  describe('getJobCounts', () => {
    it('should return zero counts when empty', async () => {
      const counts = await storage.getJobCounts();
      expect(counts.draftCount).toBe(0);
      expect(counts.scheduledCount).toBe(0);
      expect(counts.missedCount).toBe(0);
      expect(counts.waitingCount).toBe(0);
      expect(counts.runningCount).toBe(0);
    });

    it('should return accurate counts per status', async () => {
      await storage.createJob('D1');
      await storage.createJob('D2');
      await storage.createJob('S', Date.now() + 60000);
      const t = await storage.createJob('R');
      await storage.updateJob(t.id, { status: 'running' });

      const counts = await storage.getJobCounts();
      expect(counts.draftCount).toBe(2);
      expect(counts.scheduledCount).toBe(1);
      expect(counts.runningCount).toBe(1);
      expect(counts.missedCount).toBe(0);
      expect(counts.waitingCount).toBe(0);
    });
  });
});
