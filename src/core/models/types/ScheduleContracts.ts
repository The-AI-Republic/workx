/**
 * Schedule Contract Interfaces
 *
 * Platform-agnostic storage interfaces for the new schedule/execution data model.
 * Separates schedule management storage from execution tracking storage.
 */

import type {
  ScheduleEvent,
  ExecutionRecord,
  ScheduleEventException,
  ExecutionStatus,
} from './ScheduleEvent';

// ============================================================================
// Schedule Storage Interface
// ============================================================================

/**
 * Storage operations for ScheduleEvent and ScheduleEventException records.
 * Implemented by both IndexedDB (extension/desktop) and SQLite (server).
 */
export interface IScheduleStorage {
  // Event CRUD
  createEvent(event: ScheduleEvent): Promise<void>;
  getEvent(id: string): Promise<ScheduleEvent | null>;
  updateEvent(id: string, updates: Partial<ScheduleEvent>): Promise<void>;
  deleteEvent(id: string): Promise<void>;

  // Event queries
  getAllEvents(): Promise<ScheduleEvent[]>;
  getEnabledEvents(): Promise<ScheduleEvent[]>;

  /**
   * Get events that have occurrences within a time range.
   * For non-recurring events: scheduledTime falls within range.
   * For recurring events: any expanded instance falls within range (caller handles expansion).
   * This returns events whose scheduledTime <= rangeEnd (potential candidates).
   */
  getEventsInRange(startTime: number, endTime: number): Promise<ScheduleEvent[]>;

  // Exception CRUD
  createException(exception: ScheduleEventException): Promise<void>;
  getExceptions(scheduleEventId: string): Promise<ScheduleEventException[]>;
  getException(scheduleEventId: string, instanceTime: number): Promise<ScheduleEventException | null>;
  deleteException(scheduleEventId: string, instanceTime: number): Promise<void>;
  deleteAllExceptions(scheduleEventId: string): Promise<void>;
}

// ============================================================================
// Execution Storage Interface
// ============================================================================

/**
 * Storage operations for ExecutionRecord tracking.
 * Implemented by both IndexedDB (extension/desktop) and SQLite (server).
 */
export interface IExecutionStorage {
  // Execution CRUD
  createExecution(record: ExecutionRecord): Promise<void>;
  getExecution(id: string): Promise<ExecutionRecord | null>;
  updateExecution(id: string, updates: Partial<ExecutionRecord>): Promise<void>;
  deleteExecution(id: string): Promise<void>;

  // Execution queries
  getExecutionsByEvent(scheduleEventId: string): Promise<ExecutionRecord[]>;
  getExecutionByInstance(scheduleEventId: string, instanceTime: number): Promise<ExecutionRecord | null>;
  getExecutionsByStatus(status: ExecutionStatus): Promise<ExecutionRecord[]>;

  /**
   * Get executions for instances within a time range.
   */
  getExecutionsInRange(startTime: number, endTime: number): Promise<ExecutionRecord[]>;

  /**
   * Get the most recent execution for an event.
   */
  getLatestExecution(scheduleEventId: string): Promise<ExecutionRecord | null>;

  /**
   * Get all executions with a specific status (e.g., 'running' for stale detection).
   */
  getRunningExecutions(): Promise<ExecutionRecord[]>;

  /**
   * Get archived (completed/failed/cancelled) executions with pagination.
   */
  getArchivedExecutions(
    limit: number,
    offset: number,
    sortDirection?: 'newest' | 'oldest',
    statusFilter?: ExecutionStatus[]
  ): Promise<ExecutionRecord[]>;

  /**
   * Get total count of archived executions.
   */
  getArchivedExecutionsCount(statusFilter?: ExecutionStatus[]): Promise<number>;
}

// ============================================================================
// IndexedDB Schema Constants
// ============================================================================

export const SCHEDULE_EVENTS_STORE = 'schedule_events';
export const SCHEDULE_EXCEPTIONS_STORE = 'schedule_exceptions';
export const EXECUTION_RECORDS_STORE = 'execution_records';

export const SCHEDULE_EVENTS_INDEXES = [
  { name: 'by_enabled', keyPath: 'enabled', unique: false },
  { name: 'by_scheduled_time', keyPath: 'scheduledTime', unique: false },
] as const;

export const SCHEDULE_EXCEPTIONS_INDEXES = [
  { name: 'by_event_instance', keyPath: ['scheduleEventId', 'instanceTime'], unique: true },
  { name: 'by_event_id', keyPath: 'scheduleEventId', unique: false },
] as const;

export const EXECUTION_RECORDS_INDEXES = [
  { name: 'by_event_id', keyPath: 'scheduleEventId', unique: false },
  { name: 'by_status', keyPath: 'status', unique: false },
  { name: 'by_event_instance', keyPath: ['scheduleEventId', 'instanceTime'], unique: false },
  { name: 'by_instance_time', keyPath: 'instanceTime', unique: false },
] as const;
