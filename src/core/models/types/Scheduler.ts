/**
 * Scheduler Type Definitions
 *
 * Core types for the Job Scheduler feature.
 * Legacy types (SchedulerJobRecord, SchedulerJobStatus, SchedulerState) have been removed.
 * The new model uses ScheduleEvent + ExecutionRecord (see ScheduleEvent.ts / ScheduleContracts.ts).
 */

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
// Job Result
// ============================================================================

/**
 * Result record embedded in ExecutionRecord after completion
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
