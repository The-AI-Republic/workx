/**
 * Scheduler Contract Interfaces
 *
 * Interfaces for storage, alarms, and messaging in the Job Scheduler feature.
 */

import type { SchedulerJobRecord, SchedulerJobStatus, SchedulerState, RecurrenceRule } from './Scheduler';

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
// Storage Interface
// ============================================================================

/**
 * Job count result from getJobCounts()
 */
export interface SchedulerJobCounts {
  draftCount: number;
  scheduledCount: number;
  missedCount: number;
  waitingCount: number;
  runningCount: number;
}

/**
 * Storage operations interface for scheduler jobs
 */
export interface ISchedulerStorage {
  // Job CRUD
  createJob(input: string, scheduledTime?: number, recurrence?: RecurrenceRule): Promise<SchedulerJobRecord>; // No time = draft
  getJob(id: string): Promise<SchedulerJobRecord | null>;
  updateJob(id: string, updates: Partial<SchedulerJobRecord>): Promise<void>;
  deleteJob(id: string): Promise<void>;

  // Queries
  getDraftJobs(): Promise<SchedulerJobRecord[]>; // Jobs without time (status: draft)
  getScheduledJobs(): Promise<SchedulerJobRecord[]>; // Upcoming (status: scheduled)
  getMissedJobs(): Promise<SchedulerJobRecord[]>; // Overdue jobs (status: missed)
  getJobQueueJobs(): Promise<SchedulerJobRecord[]>; // Job queue (status: waiting)
  getArchivedJobs(limit: number, offset: number, sortDirection?: 'newest' | 'oldest', statusFilter?: SchedulerJobStatus[]): Promise<SchedulerJobRecord[]>;
  getArchivedJobsCount(statusFilter?: SchedulerJobStatus[]): Promise<number>;
  getNextJobInQueue(): Promise<SchedulerJobRecord | null>; // FIFO by createdAt
  getOverdueScheduledJobs(): Promise<SchedulerJobRecord[]>; // status: scheduled AND scheduledTime < now

  // Scheduler state
  getSchedulerState(): Promise<SchedulerState>;
  setSchedulerState(state: Partial<SchedulerState>): Promise<void>;

  // Job counts
  getJobCounts(): Promise<SchedulerJobCounts>;
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
  CREATE_DRAFT_JOB = 'CREATE_DRAFT_JOB',
  SCHEDULE_JOB = 'SCHEDULE_JOB',
  TRIGGER_JOB = 'TRIGGER_JOB', // Manually trigger draft/scheduled job
  CANCEL_JOB = 'CANCEL_JOB',

  // Job Queue Control
  PAUSE_JOB_QUEUE = 'PAUSE_JOB_QUEUE',
  RESUME_JOB_QUEUE = 'RESUME_JOB_QUEUE',

  // Queries
  GET_DRAFT_JOBS = 'GET_DRAFT_JOBS',
  GET_SCHEDULED_JOBS = 'GET_SCHEDULED_JOBS',
  GET_MISSED_JOBS = 'GET_MISSED_JOBS', // Jobs that missed their scheduled time
  GET_JOB_QUEUE = 'GET_JOB_QUEUE', // Jobs in waiting status
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

export interface CreateDraftJobRequest {
  input: string;
}

export interface ScheduleJobRequest {
  input?: string; // For new job with time
  jobId?: string; // For scheduling existing draft
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
  statusFilter?: SchedulerJobStatus[];
}

// ============================================================================
// Response Payloads
// ============================================================================

export interface CreateDraftJobResponse {
  success: boolean;
  jobId?: string;
  error?: string;
}

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

export interface GetDraftJobsResponse {
  jobs: SchedulerJobSummary[];
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
  draftCount: number; // Jobs without scheduled time
  scheduledCount: number; // Jobs waiting for their scheduled time
  missedCount: number; // Jobs that missed their scheduled time (requires user action)
  jobQueueCount: number; // Jobs in job queue (waiting status)
  runningJob: SchedulerJobSummary | null;
}

export interface GetJobDetailsResponse {
  job: SchedulerJobFull | null;
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface JobStatusChangedEvent {
  jobId: string;
  previousStatus: SchedulerJobStatus;
  newStatus: SchedulerJobStatus;
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
  scheduledTime: number | null; // Null for draft jobs
  status: SchedulerJobStatus;
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

export interface SchedulerJobFull {
  id: string;
  input: string;
  scheduledTime: number | null; // Null for draft jobs
  createdAt: number;
  status: SchedulerJobStatus;
  sessionId: string | null;
  completedAt: number | null;
  error: string | null;
}

// ============================================================================
// IndexedDB Schema Constants
// ============================================================================

export const SCHEDULER_JOBS_STORE = 'scheduler_jobs';

export const SCHEDULER_JOBS_INDEXES = [
  { name: 'by_status', keyPath: 'status', unique: false },
  { name: 'by_scheduled_time', keyPath: 'scheduledTime', unique: false },
  { name: 'by_status_time', keyPath: ['status', 'scheduledTime'], unique: false },
  { name: 'by_created_at', keyPath: 'createdAt', unique: false },
] as const;

export const SCHEDULER_STATE_KEY = 'scheduler_state';
