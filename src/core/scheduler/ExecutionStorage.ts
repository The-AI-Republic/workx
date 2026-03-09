/**
 * Execution Storage (IndexedDB)
 *
 * IndexedDB implementation of IExecutionStorage for extension/desktop modes.
 */

import type { StorageAdapter } from '../../storage/StorageAdapter';
import { EXECUTION_RECORDS_STORE } from '../models/types/ScheduleContracts';
import type { IExecutionStorage } from '../models/types/ScheduleContracts';
import type { ExecutionRecord, ExecutionStatus } from '../models/types/ScheduleEvent';

export class ExecutionStorage implements IExecutionStorage {
  constructor(private db: StorageAdapter) {}

  // ==========================================================================
  // Execution CRUD
  // ==========================================================================

  async createExecution(record: ExecutionRecord): Promise<void> {
    await this.db.put(EXECUTION_RECORDS_STORE, record);
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    return this.db.get<ExecutionRecord>(EXECUTION_RECORDS_STORE, id);
  }

  async updateExecution(id: string, updates: Partial<ExecutionRecord>): Promise<void> {
    const existing = await this.getExecution(id);
    if (!existing) throw new Error(`Execution record not found: ${id}`);

    const updated: ExecutionRecord = {
      ...existing,
      ...updates,
      id, // Preserve ID
    };
    await this.db.put(EXECUTION_RECORDS_STORE, updated);
  }

  async deleteExecution(id: string): Promise<void> {
    await this.db.delete(EXECUTION_RECORDS_STORE, id);
  }

  // ==========================================================================
  // Execution Queries
  // ==========================================================================

  async getExecutionsByEvent(scheduleEventId: string): Promise<ExecutionRecord[]> {
    return this.db.queryByIndex<ExecutionRecord>(
      EXECUTION_RECORDS_STORE,
      'by_event_id',
      scheduleEventId
    ).catch(() => {
      return this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE)
        .then(all => all.filter(r => r.scheduleEventId === scheduleEventId));
    });
  }

  async getExecutionByInstance(
    scheduleEventId: string,
    instanceTime: number
  ): Promise<ExecutionRecord | null> {
    try {
      const results = await this.db.queryByIndex<ExecutionRecord>(
        EXECUTION_RECORDS_STORE,
        'by_event_instance',
        [scheduleEventId, instanceTime]
      );
      return results[0] || null;
    } catch {
      const all = await this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE);
      return all.find(
        r => r.scheduleEventId === scheduleEventId && r.instanceTime === instanceTime
      ) || null;
    }
  }

  async getExecutionsByStatus(status: ExecutionStatus): Promise<ExecutionRecord[]> {
    return this.db.queryByIndex<ExecutionRecord>(
      EXECUTION_RECORDS_STORE,
      'by_status',
      status
    ).catch(() => {
      return this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE)
        .then(all => all.filter(r => r.status === status));
    });
  }

  async getExecutionsInRange(startTime: number, endTime: number): Promise<ExecutionRecord[]> {
    // Get all and filter by instanceTime range
    const all = await this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE);
    return all.filter(
      r => r.instanceTime >= startTime && r.instanceTime <= endTime
    );
  }

  async getLatestExecution(scheduleEventId: string): Promise<ExecutionRecord | null> {
    const executions = await this.getExecutionsByEvent(scheduleEventId);
    if (executions.length === 0) return null;
    return executions.sort((a, b) => b.instanceTime - a.instanceTime)[0];
  }

  async getRunningExecutions(): Promise<ExecutionRecord[]> {
    return this.getExecutionsByStatus('running');
  }

  async getArchivedExecutions(
    limit: number,
    offset: number,
    sortDirection: 'newest' | 'oldest' = 'newest',
    statusFilter?: ExecutionStatus[]
  ): Promise<ExecutionRecord[]> {
    const archiveStatuses: ExecutionStatus[] = statusFilter || ['completed', 'failed', 'cancelled'];
    const all = await this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE);
    const archived = all.filter(r => archiveStatuses.includes(r.status));
    archived.sort((a, b) =>
      sortDirection === 'newest'
        ? (b.completedAt ?? b.instanceTime) - (a.completedAt ?? a.instanceTime)
        : (a.completedAt ?? a.instanceTime) - (b.completedAt ?? b.instanceTime)
    );
    return archived.slice(offset, offset + limit);
  }

  async getArchivedExecutionsCount(statusFilter?: ExecutionStatus[]): Promise<number> {
    const archiveStatuses: ExecutionStatus[] = statusFilter || ['completed', 'failed', 'cancelled'];
    const all = await this.db.getAll<ExecutionRecord>(EXECUTION_RECORDS_STORE);
    return all.filter(r => archiveStatuses.includes(r.status)).length;
  }
}
