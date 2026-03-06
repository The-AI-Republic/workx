/**
 * Scheduler Type Definitions
 *
 * Core types for the Job Scheduler feature.
 * Enables scheduled and queued execution of AI jobs.
 */

import type { TokenUsage } from './TokenUsage';

// ============================================================================
// Recurrence Types
// ============================================================================

export type RecurrenceMode = 'daily' | 'weekly' | 'monthly' | 'custom';
export type RecurrenceIntervalUnit = 'minutes' | 'hours' | 'days' | 'weeks';
export type RecurrenceEndCondition = 'never' | 'after' | 'until';

export interface RecurrenceRule {
  mode: RecurrenceMode;
  interval?: number;
  intervalUnit?: RecurrenceIntervalUnit;
  endCondition: RecurrenceEndCondition;
  endAfterCount?: number;
  endUntilDate?: number;
  completedCount?: number;
  parentJobId?: string;
}

// ============================================================================
// Job Status
// ============================================================================

/**
 * Status values for scheduler jobs
 */
export type SchedulerJobStatus =
  | 'draft' // Job created, no scheduled time set
  | 'scheduled' // Has scheduled time, alarm is set
  | 'missed' // Scheduled time passed while browser was closed, awaiting user action
  | 'waiting' // In job queue - triggered but blocked by running job
  | 'running' // Currently executing
  | 'completed' // Successfully finished
  | 'failed' // Execution failed
  | 'cancelled'; // User cancelled

// ============================================================================
// Job Result
// ============================================================================

/**
 * Result record embedded in SchedulerJob after completion
 */
export interface JobResultRecord {
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
// Scheduler Job Record
// ============================================================================

/**
 * A job record stored in IndexedDB scheduler_jobs store
 */
export interface SchedulerJobRecord {
  /** UUID v4 primary key */
  id: string;

  /** User's job description/prompt */
  input: string;

  /** Unix timestamp (ms) when job should execute. Null for draft jobs. */
  scheduledTime: number | null;

  /** Unix timestamp (ms) when job was created */
  createdAt: number;

  /** Current job state */
  status: SchedulerJobStatus;

  /** Associated conversation session ID (set when job starts) */
  sessionId: string | null;

  /** Unix timestamp (ms) when job finished */
  completedAt: number | null;

  /** Error message if job failed */
  error: string | null;

  /** Execution result summary (set on completion) */
  result: JobResultRecord | null;

  /** Optional recurrence rule for repeat jobs */
  recurrence?: RecurrenceRule | null;
}

// ============================================================================
// Scheduler State
// ============================================================================

/**
 * Global scheduler state stored in chrome.storage.local for fast access
 */
export interface SchedulerState {
  /** Whether job queue processing is paused */
  isPaused: boolean;

  /** ID of currently running job */
  currentJobId: string | null;

  /** Timestamp of last job queue processing */
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
    currentJobId: null,
    lastProcessedTime: 0,
  };
}

/**
 * Creates a new draft job record
 */
export function createDraftJobRecord(id: string, input: string): SchedulerJobRecord {
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
 * Creates a new scheduled job record
 */
export function createScheduledJobRecord(
  id: string,
  input: string,
  scheduledTime: number
): SchedulerJobRecord {
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

/**
 * Creates a new scheduled job record with recurrence
 */
export function createScheduledJobRecordWithRecurrence(
  id: string,
  input: string,
  scheduledTime: number,
  recurrence: RecurrenceRule
): SchedulerJobRecord {
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
    recurrence,
  };
}

// ============================================================================
// Type Guards
// ============================================================================

const VALID_STATUSES: SchedulerJobStatus[] = [
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
 * Type guard to check if a value is a valid SchedulerJobStatus
 */
export function isSchedulerJobStatus(value: string): value is SchedulerJobStatus {
  return VALID_STATUSES.includes(value as SchedulerJobStatus);
}

/**
 * Type guard to check if object is a valid SchedulerJobRecord
 */
export function isSchedulerJobRecord(obj: unknown): obj is SchedulerJobRecord {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.input === 'string' &&
    (record.scheduledTime === null || typeof record.scheduledTime === 'number') &&
    typeof record.createdAt === 'number' &&
    typeof record.status === 'string' &&
    isSchedulerJobStatus(record.status) &&
    (record.sessionId === null || typeof record.sessionId === 'string') &&
    (record.completedAt === null || typeof record.completedAt === 'number') &&
    (record.error === null || typeof record.error === 'string') &&
    (record.result === null || isJobResultRecord(record.result))
  );
}

/**
 * Type guard for JobResultRecord
 */
export function isJobResultRecord(obj: unknown): obj is JobResultRecord {
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
    (state.currentJobId === null || typeof state.currentJobId === 'string') &&
    typeof state.lastProcessedTime === 'number'
  );
}

const VALID_RECURRENCE_MODES: RecurrenceMode[] = ['daily', 'weekly', 'monthly', 'custom'];
const VALID_END_CONDITIONS: RecurrenceEndCondition[] = ['never', 'after', 'until'];

/**
 * Type guard to check if object is a valid RecurrenceRule
 */
export function isRecurrenceRule(obj: unknown): obj is RecurrenceRule {
  if (!obj || typeof obj !== 'object') return false;
  const rule = obj as Record<string, unknown>;
  return (
    typeof rule.mode === 'string' &&
    VALID_RECURRENCE_MODES.includes(rule.mode as RecurrenceMode) &&
    typeof rule.endCondition === 'string' &&
    VALID_END_CONDITIONS.includes(rule.endCondition as RecurrenceEndCondition)
  );
}
