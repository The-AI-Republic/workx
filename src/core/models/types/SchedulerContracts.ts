/**
 * Scheduler Contract Interfaces
 *
 * Interfaces for storage, alarms, and messaging in the Job Scheduler feature.
 */

import type { RecurrenceRule } from './Scheduler';

// ============================================================================
// Platform-neutral Alarm Type
// ============================================================================

/**
 * Platform-neutral alarm type (structurally compatible with chrome.alarms.Alarm)
 */
export interface SchedulerAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

// ============================================================================
// Alarms Interface
// ============================================================================

/**
 * Alarm name prefix for scheduled jobs.
 * Format: scheduler-job-{jobId}
 */
export const SCHEDULER_ALARM_PREFIX = 'scheduler-job-';

/**
 * Alarm name for job queue processing check.
 * Fires periodically to process jobs in the job queue (waiting status).
 */
export const SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM = 'scheduler-job-queue-processor';

/**
 * Alarm configuration
 */
export interface SchedulerAlarmConfig {
  /** Interval for job queue processor alarm (minutes) */
  jobQueueProcessorInterval: number;

  /** Minimum delay before job execution (ms) - chrome.alarms minimum is 1 minute */
  minScheduleDelay: number;
}

export const DEFAULT_ALARM_CONFIG: SchedulerAlarmConfig = {
  jobQueueProcessorInterval: 1, // 1 minute
  minScheduleDelay: 60000, // 1 minute (chrome.alarms minimum)
};

/**
 * Alarms operations interface
 */
export interface ISchedulerAlarms {
  /**
   * Create an alarm for a scheduled job.
   * @param jobId - The job ID
   * @param scheduledTime - Unix timestamp when job should execute
   */
  createJobAlarm(jobId: string, scheduledTime: number): Promise<void>;

  /**
   * Clear an alarm for a scheduled job (e.g., when cancelled).
   * @param jobId - The job ID
   */
  clearJobAlarm(jobId: string): Promise<void>;

  /**
   * Check if an alarm exists for a job.
   * @param jobId - The job ID
   */
  hasJobAlarm(jobId: string): Promise<boolean>;

  /**
   * Start the job queue processor alarm.
   * Called on extension startup. Periodically checks for jobs to execute.
   */
  startJobQueueProcessor(): Promise<void>;

  /**
   * Stop the job queue processor alarm.
   * Called when scheduler is paused.
   */
  stopJobQueueProcessor(): Promise<void>;

  /**
   * Get all active scheduler alarms.
   */
  getAllAlarms(): Promise<SchedulerAlarm[]>;
}

/**
 * Alarm event types
 */
export type SchedulerAlarmEvent =
  | { type: 'job'; jobId: string }
  | { type: 'scheduler-job-queue-processor' };

/**
 * Parse alarm name to determine event type.
 */
export function parseAlarmName(alarmName: string): SchedulerAlarmEvent | null {
  if (alarmName === SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM) {
    return { type: 'scheduler-job-queue-processor' };
  }
  if (alarmName.startsWith(SCHEDULER_ALARM_PREFIX)) {
    const jobId = alarmName.slice(SCHEDULER_ALARM_PREFIX.length);
    return { type: 'job', jobId };
  }
  return null;
}

/**
 * Generate alarm name for a job.
 */
export function getJobAlarmName(jobId: string): string {
  return `${SCHEDULER_ALARM_PREFIX}${jobId}`;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Scheduler message types for UI-background communication
 */
export enum SchedulerMessageType {
  // Job Management
  SCHEDULE_JOB = 'SCHEDULE_JOB',
  TRIGGER_JOB = 'TRIGGER_JOB',
  CANCEL_JOB = 'CANCEL_JOB',

  // Job Queue Control
  PAUSE_JOB_QUEUE = 'PAUSE_JOB_QUEUE',
  RESUME_JOB_QUEUE = 'RESUME_JOB_QUEUE',

  // Queries
  GET_SCHEDULED_JOBS = 'GET_SCHEDULED_JOBS',
  GET_MISSED_JOBS = 'GET_MISSED_JOBS',
  GET_JOB_QUEUE = 'GET_JOB_QUEUE',
  GET_ARCHIVED_JOBS = 'GET_ARCHIVED_JOBS',
  GET_SCHEDULER_STATE = 'GET_SCHEDULER_STATE',
  GET_JOB_DETAILS = 'GET_JOB_DETAILS',

  // Events (background -> UI)
  JOB_STATUS_CHANGED = 'JOB_STATUS_CHANGED',
  SCHEDULER_STATE_CHANGED = 'SCHEDULER_STATE_CHANGED',
}

// ============================================================================
// Request Payloads
// ============================================================================

export interface ScheduleJobRequest {
  input: string;
  scheduledTime: number; // Unix timestamp in ms
  recurrence?: RecurrenceRule; // Optional repeat configuration
}

export interface TriggerJobRequest {
  jobId: string; // Manually trigger a draft or scheduled job
}

export interface CancelJobRequest {
  jobId: string;
}

export interface GetJobDetailsRequest {
  jobId: string;
}

export interface GetArchivedJobsRequest {
  limit?: number; // Default: 50
  offset?: number; // Default: 0
  sortDirection?: 'newest' | 'oldest';
  statusFilter?: string[];
}

export interface RescheduleJobRequest {
  jobId: string;
  scheduledTime: number;
}

export interface RescheduleJobResponse {
  success: boolean;
  error?: string;
}

export interface GetAllJobsInRangeRequest {
  startTime: number;
  endTime: number;
}

export interface GetAllJobsInRangeResponse {
  jobs: SchedulerJobSummary[];
}

// ============================================================================
// Response Payloads
// ============================================================================

export interface ScheduleJobResponse {
  success: boolean;
  jobId?: string;
  error?: string;
}

export interface TriggerJobResponse {
  success: boolean;
  error?: string;
}

export interface CancelJobResponse {
  success: boolean;
  error?: string;
}

export interface GetScheduledJobsResponse {
  jobs: SchedulerJobSummary[];
}

export interface GetMissedJobsResponse {
  jobs: SchedulerJobSummary[]; // Jobs with 'missed' status
}

export interface GetJobQueueResponse {
  jobs: SchedulerJobSummary[]; // Jobs in 'waiting' status (FIFO)
}

export interface GetArchivedJobsResponse {
  jobs: ArchivedJobSummary[];
  total: number;
  hasMore: boolean;
}

export interface GetSchedulerStateResponse {
  isPaused: boolean;
  currentJobId: string | null;
  draftCount: number; // Always 0 (kept for UI compatibility)
  scheduledCount: number; // Events waiting for their scheduled time
  missedCount: number; // Instances that missed their scheduled time
  jobQueueCount: number; // Pending executions in queue
  runningJob: SchedulerJobSummary | null;
}

export interface GetJobDetailsResponse {
  job: unknown | null;
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface JobStatusChangedEvent {
  jobId: string;
  previousStatus: string;
  newStatus: string;
  timestamp: number;
}

export interface SchedulerStateChangedEvent {
  isPaused: boolean;
  currentJobId: string | null;
}

// ============================================================================
// Shared Types for Messages
// ============================================================================

export interface SchedulerJobSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number | null;
  status: string;
  createdAt: number;
  recurrence?: RecurrenceRule | null;
}

export interface ArchivedJobSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number | null;
  completedAt: number;
  status: 'completed' | 'failed' | 'cancelled';
  sessionId: string | null;
  error?: string;
  recurrence?: RecurrenceRule | null;
}

// ============================================================================
// IndexedDB Schema Constants (kept for schema compatibility — do not remove without version bump)
// ============================================================================

export const SCHEDULER_JOBS_STORE = 'scheduler_jobs';

export const SCHEDULER_JOBS_INDEXES = [
  { name: 'by_status', keyPath: 'status', unique: false },
  { name: 'by_scheduled_time', keyPath: 'scheduledTime', unique: false },
  { name: 'by_status_time', keyPath: ['status', 'scheduledTime'], unique: false },
  { name: 'by_created_at', keyPath: 'createdAt', unique: false },
] as const;

export const SCHEDULER_STATE_KEY = 'scheduler_state';
