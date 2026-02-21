/**
 * Scheduler Type Definitions
 *
 * Core types for the Task Scheduler feature.
 * Enables scheduled and queued execution of AI tasks.
 */

import type { TokenUsage } from './TokenUsage';

// ============================================================================
// Task Status
// ============================================================================

/**
 * Status values for scheduler tasks
 */
export type SchedulerTaskStatus =
  | 'draft' // Task created, no scheduled time set
  | 'scheduled' // Has scheduled time, alarm is set
  | 'missed' // Scheduled time passed while browser was closed, awaiting user action
  | 'waiting' // In SchedulerTaskQueue - triggered but blocked by running task
  | 'running' // Currently executing
  | 'completed' // Successfully finished
  | 'failed' // Execution failed
  | 'cancelled'; // User cancelled

// ============================================================================
// Task Result
// ============================================================================

/**
 * Result record embedded in SchedulerTask after completion
 */
export interface TaskResultRecord {
  /** Brief outcome summary (first 200 chars of response) */
  summary: string;

  /** Token consumption stats */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Execution time in milliseconds */
  duration: number;
}

// ============================================================================
// Scheduler Task Record
// ============================================================================

/**
 * A task record stored in IndexedDB scheduler_tasks store
 */
export interface SchedulerTaskRecord {
  /** UUID v4 primary key */
  id: string;

  /** User's task description/prompt */
  input: string;

  /** Unix timestamp (ms) when task should execute. Null for draft tasks. */
  scheduledTime: number | null;

  /** Unix timestamp (ms) when task was created */
  createdAt: number;

  /** Current task state */
  status: SchedulerTaskStatus;

  /** Associated conversation session ID (set when task starts) */
  sessionId: string | null;

  /** Unix timestamp (ms) when task finished */
  completedAt: number | null;

  /** Error message if task failed */
  error: string | null;

  /** Execution result summary (set on completion) */
  result: TaskResultRecord | null;
}

// ============================================================================
// Scheduler State
// ============================================================================

/**
 * Global scheduler state stored in chrome.storage.local for fast access
 */
export interface SchedulerState {
  /** Whether SchedulerTaskQueue processing is paused */
  isPaused: boolean;

  /** ID of currently running task */
  currentTaskId: string | null;

  /** Timestamp of last SchedulerTaskQueue processing */
  lastProcessedTime: number;
}

// ============================================================================
// Default/Factory Functions
// ============================================================================

/**
 * Creates a default SchedulerState
 */
export function createDefaultSchedulerState(): SchedulerState {
  return {
    isPaused: false,
    currentTaskId: null,
    lastProcessedTime: 0,
  };
}

/**
 * Creates a new draft task record
 */
export function createDraftTaskRecord(id: string, input: string): SchedulerTaskRecord {
  return {
    id,
    input,
    scheduledTime: null,
    createdAt: Date.now(),
    status: 'draft',
    sessionId: null,
    completedAt: null,
    error: null,
    result: null,
  };
}

/**
 * Creates a new scheduled task record
 */
export function createScheduledTaskRecord(
  id: string,
  input: string,
  scheduledTime: number
): SchedulerTaskRecord {
  return {
    id,
    input,
    scheduledTime,
    createdAt: Date.now(),
    status: 'scheduled',
    sessionId: null,
    completedAt: null,
    error: null,
    result: null,
  };
}

// ============================================================================
// Type Guards
// ============================================================================

const VALID_STATUSES: SchedulerTaskStatus[] = [
  'draft',
  'scheduled',
  'missed',
  'waiting',
  'running',
  'completed',
  'failed',
  'cancelled',
];

/**
 * Type guard to check if a string is a valid SchedulerTaskStatus
 */
export function isSchedulerTaskStatus(value: string): value is SchedulerTaskStatus {
  return VALID_STATUSES.includes(value as SchedulerTaskStatus);
}

/**
 * Type guard to check if object is a valid SchedulerTaskRecord
 */
export function isSchedulerTaskRecord(obj: unknown): obj is SchedulerTaskRecord {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.input === 'string' &&
    (record.scheduledTime === null || typeof record.scheduledTime === 'number') &&
    typeof record.createdAt === 'number' &&
    typeof record.status === 'string' &&
    isSchedulerTaskStatus(record.status) &&
    (record.sessionId === null || typeof record.sessionId === 'string') &&
    (record.completedAt === null || typeof record.completedAt === 'number') &&
    (record.error === null || typeof record.error === 'string') &&
    (record.result === null || isTaskResultRecord(record.result))
  );
}

/**
 * Type guard to check if object is a valid TaskResultRecord
 */
export function isTaskResultRecord(obj: unknown): obj is TaskResultRecord {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.summary === 'string' &&
    typeof record.duration === 'number' &&
    typeof record.tokenUsage === 'object' &&
    record.tokenUsage !== null
  );
}

/**
 * Type guard to check if object is a valid SchedulerState
 */
export function isSchedulerState(obj: unknown): obj is SchedulerState {
  if (!obj || typeof obj !== 'object') return false;
  const state = obj as Record<string, unknown>;
  return (
    typeof state.isPaused === 'boolean' &&
    (state.currentTaskId === null || typeof state.currentTaskId === 'string') &&
    typeof state.lastProcessedTime === 'number'
  );
}
