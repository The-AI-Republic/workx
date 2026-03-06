/**
 * Scheduler Storage
 *
 * IndexedDB persistence layer for scheduler jobs.
 * Implements ISchedulerStorage interface.
 */

import { v4 as uuidv4 } from 'uuid';
import type { StorageAdapter } from '../../storage/StorageAdapter';
import { STORE_NAMES, INDEX_NAMES } from '../../storage/IndexedDBAdapter';
import type {
  SchedulerJobRecord,
  SchedulerState,
} from '../models/types/Scheduler';
import {
  createDefaultSchedulerState,
  createDraftJobRecord,
  createScheduledJobRecord,
} from '../models/types/Scheduler';
import type { ISchedulerStorage } from '../models/types/SchedulerContracts';
import { SCHEDULER_STATE_KEY } from '../models/types/SchedulerContracts';
import {
  getConfigStorage,
  isConfigStorageInitialized,
  type ConfigStorageProvider
} from '../storage/ConfigStorageProvider';

/**
 * Storage implementation for scheduler jobs
 */
export class SchedulerStorage implements ISchedulerStorage {
  constructor(private db: StorageAdapter) {}

  /**
   * Create a new job
   * @param input - Job input/prompt
   * @param scheduledTime - Optional scheduled time (if omitted, creates draft)
   */
  async createJob(input: string, scheduledTime?: number): Promise<SchedulerJobRecord> {
    const id = uuidv4();
    const job = scheduledTime
      ? createScheduledJobRecord(id, input, scheduledTime)
      : createDraftJobRecord(id, input);

    await this.db.put(STORE_NAMES.SCHEDULER_JOBS, job);
    return job;
  }

  /**
   * Get a job by ID
   */
  async getJob(id: string): Promise<SchedulerJobRecord | null> {
    return this.db.get<SchedulerJobRecord>(STORE_NAMES.SCHEDULER_JOBS, id);
  }

  /**
   * Update a job
   */
  async updateJob(id: string, updates: Partial<SchedulerJobRecord>): Promise<void> {
    const existing = await this.getJob(id);
    if (!existing) {
      throw new Error(`Job not found: ${id}`);
    }

    const updated: SchedulerJobRecord = {
      ...existing,
      ...updates,
      id, // Ensure ID is preserved
    };

    await this.db.put(STORE_NAMES.SCHEDULER_JOBS, updated);
  }

  /**
   * Delete a job
   */
  async deleteJob(id: string): Promise<void> {
    await this.db.delete(STORE_NAMES.SCHEDULER_JOBS, id);
  }

  /**
   * Get all draft jobs (no scheduled time)
   */
  async getDraftJobs(): Promise<SchedulerJobRecord[]> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'draft'
    );
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get all scheduled jobs (awaiting their scheduled time)
   */
  async getScheduledJobs(): Promise<SchedulerJobRecord[]> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'scheduled'
    );
    return jobs.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
  }

  /**
   * Get all missed jobs (scheduled time passed while browser was closed)
   */
  async getMissedJobs(): Promise<SchedulerJobRecord[]> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'missed'
    );
    return jobs.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
  }

  /**
   * Get jobs in the job queue (waiting status)
   */
  async getJobQueueJobs(): Promise<SchedulerJobRecord[]> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'waiting'
    );
    // FIFO order by createdAt
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get archived jobs (completed, failed, or cancelled)
   */
  async getArchivedJobs(
    limit: number,
    offset: number,
    sortDirection: 'newest' | 'oldest' = 'newest',
    statusFilter?: string[]
  ): Promise<SchedulerJobRecord[]> {
    const statuses = statusFilter && statusFilter.length > 0
      ? statusFilter
      : ['completed', 'failed', 'cancelled'];

    const results = await Promise.all(
      statuses.map(status =>
        this.db.queryByIndex<SchedulerJobRecord>(
          STORE_NAMES.SCHEDULER_JOBS,
          INDEX_NAMES.SCHEDULER_BY_STATUS,
          status
        )
      )
    );

    const archived = results.flat().sort((a, b) =>
      sortDirection === 'newest'
        ? (b.completedAt || 0) - (a.completedAt || 0)
        : (a.completedAt || 0) - (b.completedAt || 0)
    );

    return archived.slice(offset, offset + limit);
  }

  /**
   * Count archived jobs (completed, failed, or cancelled)
   */
  async getArchivedJobsCount(statusFilter?: string[]): Promise<number> {
    const statuses = statusFilter && statusFilter.length > 0
      ? statusFilter
      : ['completed', 'failed', 'cancelled'];

    const results = await Promise.all(
      statuses.map(status =>
        this.db.queryByIndex<SchedulerJobRecord>(
          STORE_NAMES.SCHEDULER_JOBS,
          INDEX_NAMES.SCHEDULER_BY_STATUS,
          status
        )
      )
    );

    return results.reduce((sum, arr) => sum + arr.length, 0);
  }

  /**
   * Get all jobs whose scheduledTime falls within a date range (inclusive).
   * Skips jobs with null scheduledTime (drafts).
   */
  async getAllJobsInRange(startTime: number, endTime: number): Promise<SchedulerJobRecord[]> {
    const allJobs = await this.db.getAll<SchedulerJobRecord>(STORE_NAMES.SCHEDULER_JOBS);
    return allJobs.filter(
      (job) => job.scheduledTime != null && job.scheduledTime >= startTime && job.scheduledTime <= endTime
    );
  }

  /**
   * Get the next job in the queue (FIFO by createdAt)
   */
  async getNextJobInQueue(): Promise<SchedulerJobRecord | null> {
    const queue = await this.getJobQueueJobs();
    return queue[0] || null;
  }

  /**
   * Get overdue scheduled jobs (status: scheduled AND scheduledTime < now)
   */
  async getOverdueScheduledJobs(): Promise<SchedulerJobRecord[]> {
    const scheduled = await this.getScheduledJobs();
    const now = Date.now();
    return scheduled.filter(job => job.scheduledTime !== null && job.scheduledTime < now);
  }

  /**
   * Get the current job (running status)
   */
  async getCurrentJob(): Promise<SchedulerJobRecord | null> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      'running'
    );
    return jobs[0] || null;
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
   * Count jobs by status
   */
  async countByStatus(status: string): Promise<number> {
    const jobs = await this.db.queryByIndex<SchedulerJobRecord>(
      STORE_NAMES.SCHEDULER_JOBS,
      INDEX_NAMES.SCHEDULER_BY_STATUS,
      status
    );
    return jobs.length;
  }

  /**
   * Get job counts for UI display
   */
  async getJobCounts(): Promise<{
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
