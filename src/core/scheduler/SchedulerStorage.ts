/**
 * Scheduler Storage
 *
 * IndexedDB persistence layer for scheduler tasks.
 * Implements ISchedulerStorage interface.
 */

import { v4 as uuidv4 } from 'uuid';
import { IndexedDBAdapter, STORE_NAMES, INDEX_NAMES } from '../../storage/IndexedDBAdapter';
import type {
  SchedulerTaskRecord,
  SchedulerState,
} from '../models/types/Scheduler';
import {
  createDefaultSchedulerState,
  createDraftTaskRecord,
  createScheduledTaskRecord,
} from '../models/types/Scheduler';
import type { ISchedulerStorage } from '../models/types/SchedulerContracts';
import { SCHEDULER_STATE_KEY } from '../models/types/SchedulerContracts';
import {
  getConfigStorage,
  isConfigStorageInitialized,
  type ConfigStorageProvider
} from '../storage/ConfigStorageProvider';

/**
 * Storage implementation for scheduler tasks
 */
export class SchedulerStorage implements ISchedulerStorage {
  constructor(private db: IndexedDBAdapter) {}

  /**
   * Create a new task
   * @param input - Task input/prompt
   * @param scheduledTime - Optional scheduled time (if omitted, creates draft)
   */
  async createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord> {
    const id = uuidv4();
    const task = scheduledTime
      ? createScheduledTaskRecord(id, input, scheduledTime)
      : createDraftTaskRecord(id, input);

    await this.db.put(STORE_NAMES.SCHEDULER_TASKS, task);
    return task;
  }

  /**
   * Get a task by ID
   */
  async getTask(id: string): Promise<SchedulerTaskRecord | null> {
    return this.db.get<SchedulerTaskRecord>(STORE_NAMES.SCHEDULER_TASKS, id);
  }

  /**
   * Update a task
   */
  async updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void> {
    const existing = await this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const updated: SchedulerTaskRecord = {
      ...existing,
      ...updates,
      id, // Ensure ID is preserved
    };

    await this.db.put(STORE_NAMES.SCHEDULER_TASKS, updated);
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<void> {
    await this.db.delete(STORE_NAMES.SCHEDULER_TASKS, id);
  }

  /**
   * Get all draft tasks (no scheduled time)
   */
  async getDraftTasks(): Promise<SchedulerTaskRecord[]> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'draft'
    );
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get all scheduled tasks (awaiting their scheduled time)
   */
  async getScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'scheduled'
    );
    return tasks.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
  }

  /**
   * Get all missed tasks (scheduled time passed while browser was closed)
   */
  async getMissedTasks(): Promise<SchedulerTaskRecord[]> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'missed'
    );
    return tasks.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
  }

  /**
   * Get tasks in the SchedulerTaskQueue (waiting status)
   */
  async getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'waiting'
    );
    // FIFO order by createdAt
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get archived tasks (completed or failed)
   */
  async getArchivedTasks(limit: number, offset: number): Promise<SchedulerTaskRecord[]> {
    const completed = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'completed'
    );
    const failed = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'failed'
    );

    const archived = [...completed, ...failed]
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    return archived.slice(offset, offset + limit);
  }

  /**
   * Get the next task in the SchedulerTaskQueue (FIFO by createdAt)
   */
  async getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null> {
    const queue = await this.getSchedulerTaskQueueTasks();
    return queue[0] || null;
  }

  /**
   * Get overdue scheduled tasks (status: scheduled AND scheduledTime < now)
   */
  async getOverdueScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    const scheduled = await this.getScheduledTasks();
    const now = Date.now();
    return scheduled.filter(task => task.scheduledTime !== null && task.scheduledTime < now);
  }

  /**
   * Get the current task (running status)
   */
  async getCurrentTask(): Promise<SchedulerTaskRecord | null> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'running'
    );
    return tasks[0] || null;
  }

  /**
   * Get storage provider with fallback
   */
  private async getStorage(): Promise<ConfigStorageProvider | null> {
    if (isConfigStorageInitialized()) {
      return getConfigStorage();
    }
    // Fallback to chrome.storage.local if provider not initialized
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return {
        async get<T>(key: string): Promise<T | null> {
          return new Promise((resolve) => {
            chrome.storage.local.get([key], (result) => {
              resolve((result[key] as T) ?? null);
            });
          });
        },
        async set<T>(key: string, value: T): Promise<void> {
          return new Promise((resolve, reject) => {
            chrome.storage.local.set({ [key]: value }, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve();
              }
            });
          });
        },
        async remove(key: string): Promise<void> {
          return new Promise((resolve) => {
            chrome.storage.local.remove(key, () => resolve());
          });
        },
        async getMany<T>(keys: string[]): Promise<Record<string, T>> {
          return new Promise((resolve) => {
            chrome.storage.local.get(keys, (result) => {
              resolve(result as Record<string, T>);
            });
          });
        },
        async setMany<T>(items: Record<string, T>): Promise<void> {
          return new Promise((resolve, reject) => {
            chrome.storage.local.set(items, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve();
              }
            });
          });
        },
        async removeMany(keys: string[]): Promise<void> {
          return new Promise((resolve) => {
            chrome.storage.local.remove(keys, () => resolve());
          });
        },
        async getAll(): Promise<Record<string, unknown>> {
          return new Promise((resolve) => {
            chrome.storage.local.get(null, (result) => resolve(result));
          });
        },
        async clear(): Promise<void> {
          return new Promise((resolve) => {
            chrome.storage.local.clear(() => resolve());
          });
        },
        async getBytesInUse(): Promise<number | null> {
          return null;
        }
      };
    }
    return null;
  }

  /**
   * Get scheduler state from storage
   */
  async getSchedulerState(): Promise<SchedulerState> {
    try {
      const storage = await this.getStorage();
      if (!storage) {
        return createDefaultSchedulerState();
      }
      const state = await storage.get<SchedulerState>(SCHEDULER_STATE_KEY);
      return state ?? createDefaultSchedulerState();
    } catch (error) {
      console.warn('[SchedulerStorage] Failed to get scheduler state:', error);
      return createDefaultSchedulerState();
    }
  }

  /**
   * Update scheduler state in storage
   */
  async setSchedulerState(state: Partial<SchedulerState>): Promise<void> {
    const storage = await this.getStorage();
    if (!storage) {
      throw new Error('Storage not available');
    }

    const current = await this.getSchedulerState();
    const updated: SchedulerState = {
      ...current,
      ...state,
    };

    await storage.set(SCHEDULER_STATE_KEY, updated);
  }

  /**
   * Count tasks by status
   */
  async countByStatus(status: string): Promise<number> {
    const tasks = await this.db.queryByIndex<SchedulerTaskRecord>(
      STORE_NAMES.SCHEDULER_TASKS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      status
    );
    return tasks.length;
  }

  /**
   * Get task counts for UI display
   */
  async getTaskCounts(): Promise<{
    draftCount: number;
    scheduledCount: number;
    missedCount: number;
    waitingCount: number;
    runningCount: number;
  }> {
    const [draftCount, scheduledCount, missedCount, waitingCount, runningCount] =
      await Promise.all([
        this.countByStatus('draft'),
        this.countByStatus('scheduled'),
        this.countByStatus('missed'),
        this.countByStatus('waiting'),
        this.countByStatus('running'),
      ]);

    return {
      draftCount,
      scheduledCount,
      missedCount,
      waitingCount,
      runningCount,
    };
  }
}
