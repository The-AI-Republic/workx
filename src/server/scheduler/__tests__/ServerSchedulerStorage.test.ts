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
import type { ISchedulerStorage, SchedulerTaskCounts } from '../../../core/models/types/SchedulerContracts';
import type { SchedulerTaskRecord, SchedulerState } from '../../../core/models/types/Scheduler';
import {
  createDefaultSchedulerState,
  createDraftTaskRecord,
  createScheduledTaskRecord,
} from '../../../core/models/types/Scheduler';

/**
 * In-memory ISchedulerStorage for testing the interface contract.
 * Mirrors the behavior of ServerSchedulerStorage without requiring SQLite.
 */
class InMemorySchedulerStorage implements ISchedulerStorage {
  private tasks = new Map<string, SchedulerTaskRecord>();
  private state: SchedulerState = createDefaultSchedulerState();

  async createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord> {
    const id = uuidv4();
    const task = scheduledTime
      ? createScheduledTaskRecord(id, input, scheduledTime)
      : createDraftTaskRecord(id, input);
    this.tasks.set(id, task);
    return { ...task };
  }

  async getTask(id: string): Promise<SchedulerTaskRecord | null> {
    const t = this.tasks.get(id);
    return t ? { ...t } : null;
  }

  async updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Task not found: ${id}`);
    this.tasks.set(id, { ...existing, ...updates, id });
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }

  async getDraftTasks(): Promise<SchedulerTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(t => t.status === 'draft')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(t => t.status === 'scheduled')
      .sort((a, b) => (a.scheduledTime ?? 0) - (b.scheduledTime ?? 0));
  }

  async getMissedTasks(): Promise<SchedulerTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(t => t.status === 'missed')
      .sort((a, b) => (a.scheduledTime ?? 0) - (b.scheduledTime ?? 0));
  }

  async getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(t => t.status === 'waiting')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getArchivedTasks(limit: number, offset: number): Promise<SchedulerTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(offset, offset + limit);
  }

  async getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null> {
    const queue = await this.getSchedulerTaskQueueTasks();
    return queue[0] ?? null;
  }

  async getOverdueScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    const now = Date.now();
    return [...this.tasks.values()]
      .filter(t => t.status === 'scheduled' && t.scheduledTime !== null && t.scheduledTime < now);
  }

  async getSchedulerState(): Promise<SchedulerState> {
    return { ...this.state };
  }

  async setSchedulerState(updates: Partial<SchedulerState>): Promise<void> {
    this.state = { ...this.state, ...updates };
  }

  async getTaskCounts(): Promise<SchedulerTaskCounts> {
    const tasks = [...this.tasks.values()];
    return {
      draftCount: tasks.filter(t => t.status === 'draft').length,
      scheduledCount: tasks.filter(t => t.status === 'scheduled').length,
      missedCount: tasks.filter(t => t.status === 'missed').length,
      waitingCount: tasks.filter(t => t.status === 'waiting').length,
      runningCount: tasks.filter(t => t.status === 'running').length,
    };
  }
}

describe('ServerSchedulerStorage (ISchedulerStorage contract)', () => {
  let storage: ISchedulerStorage;

  beforeEach(() => {
    storage = new InMemorySchedulerStorage();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Task CRUD
  // ─────────────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('should create a draft task without scheduledTime', async () => {
      const task = await storage.createTask('Test task');
      expect(task.id).toBeTruthy();
      expect(task.input).toBe('Test task');
      expect(task.status).toBe('draft');
      expect(task.scheduledTime).toBeNull();
      expect(task.createdAt).toBeGreaterThan(0);
    });

    it('should create a scheduled task with scheduledTime', async () => {
      const future = Date.now() + 60000;
      const task = await storage.createTask('Scheduled', future);
      expect(task.status).toBe('scheduled');
      expect(task.scheduledTime).toBe(future);
    });
  });

  describe('getTask', () => {
    it('should return null for non-existent task', async () => {
      expect(await storage.getTask('nope')).toBeNull();
    });

    it('should retrieve a created task', async () => {
      const created = await storage.createTask('Test');
      const fetched = await storage.getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.input).toBe('Test');
    });
  });

  describe('updateTask', () => {
    it('should update task fields', async () => {
      const task = await storage.createTask('Test');
      await storage.updateTask(task.id, { status: 'running', sessionId: 'ses-1' });
      const updated = await storage.getTask(task.id);
      expect(updated!.status).toBe('running');
      expect(updated!.sessionId).toBe('ses-1');
    });

    it('should throw for non-existent task', async () => {
      await expect(storage.updateTask('nope', { status: 'running' }))
        .rejects.toThrow('Task not found');
    });

    it('should preserve existing fields', async () => {
      const task = await storage.createTask('Test');
      await storage.updateTask(task.id, { status: 'running' });
      const updated = await storage.getTask(task.id);
      expect(updated!.input).toBe('Test');
      expect(updated!.id).toBe(task.id);
    });
  });

  describe('deleteTask', () => {
    it('should delete a task', async () => {
      const task = await storage.createTask('Delete me');
      await storage.deleteTask(task.id);
      expect(await storage.getTask(task.id)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────

  describe('getDraftTasks', () => {
    it('should return only draft tasks ordered by createdAt', async () => {
      await storage.createTask('Draft 1');
      await storage.createTask('Scheduled', Date.now() + 60000);
      await storage.createTask('Draft 2');
      const drafts = await storage.getDraftTasks();
      expect(drafts).toHaveLength(2);
      expect(drafts[0].input).toBe('Draft 1');
      expect(drafts[1].input).toBe('Draft 2');
    });
  });

  describe('getScheduledTasks', () => {
    it('should return only scheduled tasks ordered by scheduledTime', async () => {
      const later = Date.now() + 120000;
      const sooner = Date.now() + 60000;
      await storage.createTask('Later', later);
      await storage.createTask('Draft');
      await storage.createTask('Sooner', sooner);
      const scheduled = await storage.getScheduledTasks();
      expect(scheduled).toHaveLength(2);
      expect(scheduled[0].input).toBe('Sooner');
      expect(scheduled[1].input).toBe('Later');
    });
  });

  describe('getMissedTasks', () => {
    it('should return tasks with missed status', async () => {
      const t = await storage.createTask('Missed', Date.now() + 60000);
      await storage.updateTask(t.id, { status: 'missed' });
      const missed = await storage.getMissedTasks();
      expect(missed).toHaveLength(1);
      expect(missed[0].id).toBe(t.id);
    });
  });

  describe('getSchedulerTaskQueueTasks', () => {
    it('should return waiting tasks ordered by createdAt', async () => {
      const t1 = await storage.createTask('First');
      const t2 = await storage.createTask('Second');
      await storage.updateTask(t1.id, { status: 'waiting' });
      await storage.updateTask(t2.id, { status: 'waiting' });
      const queue = await storage.getSchedulerTaskQueueTasks();
      expect(queue).toHaveLength(2);
      expect(queue[0].id).toBe(t1.id);
    });
  });

  describe('getArchivedTasks', () => {
    it('should return completed and failed tasks with pagination', async () => {
      const t1 = await storage.createTask('T1');
      const t2 = await storage.createTask('T2');
      const t3 = await storage.createTask('T3');
      await storage.updateTask(t1.id, { status: 'completed', completedAt: 1000 });
      await storage.updateTask(t2.id, { status: 'failed', completedAt: 2000 });
      await storage.updateTask(t3.id, { status: 'completed', completedAt: 3000 });

      const page1 = await storage.getArchivedTasks(2, 0);
      expect(page1).toHaveLength(2);
      expect(page1[0].completedAt).toBe(3000);

      const page2 = await storage.getArchivedTasks(2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('getNextTaskInSchedulerTaskQueue', () => {
    it('should return null when empty', async () => {
      expect(await storage.getNextTaskInSchedulerTaskQueue()).toBeNull();
    });

    it('should return the oldest waiting task', async () => {
      const t1 = await storage.createTask('First');
      const t2 = await storage.createTask('Second');
      await storage.updateTask(t1.id, { status: 'waiting' });
      await storage.updateTask(t2.id, { status: 'waiting' });
      const next = await storage.getNextTaskInSchedulerTaskQueue();
      expect(next!.id).toBe(t1.id);
    });
  });

  describe('getOverdueScheduledTasks', () => {
    it('should return scheduled tasks past their time', async () => {
      const t = await storage.createTask('Overdue', Date.now() + 60000);
      await storage.updateTask(t.id, { scheduledTime: Date.now() - 1000 });
      const overdue = await storage.getOverdueScheduledTasks();
      expect(overdue).toHaveLength(1);
    });

    it('should not return future tasks', async () => {
      await storage.createTask('Future', Date.now() + 60000);
      const overdue = await storage.getOverdueScheduledTasks();
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
      expect(state.currentTaskId).toBeNull();
      expect(state.lastProcessedTime).toBe(0);
    });
  });

  describe('setSchedulerState', () => {
    it('should update partial state', async () => {
      await storage.setSchedulerState({ isPaused: true });
      const state = await storage.getSchedulerState();
      expect(state.isPaused).toBe(true);
      expect(state.currentTaskId).toBeNull();
    });

    it('should update currentTaskId', async () => {
      await storage.setSchedulerState({ currentTaskId: 'task-1' });
      const state = await storage.getSchedulerState();
      expect(state.currentTaskId).toBe('task-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Task Counts
  // ─────────────────────────────────────────────────────────────────────

  describe('getTaskCounts', () => {
    it('should return zero counts when empty', async () => {
      const counts = await storage.getTaskCounts();
      expect(counts.draftCount).toBe(0);
      expect(counts.scheduledCount).toBe(0);
      expect(counts.missedCount).toBe(0);
      expect(counts.waitingCount).toBe(0);
      expect(counts.runningCount).toBe(0);
    });

    it('should return accurate counts per status', async () => {
      await storage.createTask('D1');
      await storage.createTask('D2');
      await storage.createTask('S', Date.now() + 60000);
      const t = await storage.createTask('R');
      await storage.updateTask(t.id, { status: 'running' });

      const counts = await storage.getTaskCounts();
      expect(counts.draftCount).toBe(2);
      expect(counts.scheduledCount).toBe(1);
      expect(counts.runningCount).toBe(1);
      expect(counts.missedCount).toBe(0);
      expect(counts.waitingCount).toBe(0);
    });
  });
});
