/**
 * Scheduler Contract Interfaces
 *
 * Interfaces for storage, alarms, and messaging in the Task Scheduler feature.
 */

import type { SchedulerTaskRecord, SchedulerTaskStatus, SchedulerState } from './Scheduler';

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
 * Task count result from getTaskCounts()
 */
export interface SchedulerTaskCounts {
  draftCount: number;
  scheduledCount: number;
  missedCount: number;
  waitingCount: number;
  runningCount: number;
}

/**
 * Storage operations interface for scheduler tasks
 */
export interface ISchedulerStorage {
  // Task CRUD
  createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord>; // No time = draft
  getTask(id: string): Promise<SchedulerTaskRecord | null>;
  updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void>;
  deleteTask(id: string): Promise<void>;

  // Queries
  getDraftTasks(): Promise<SchedulerTaskRecord[]>; // Tasks without time (status: draft)
  getScheduledTasks(): Promise<SchedulerTaskRecord[]>; // Upcoming (status: scheduled)
  getMissedTasks(): Promise<SchedulerTaskRecord[]>; // Overdue tasks (status: missed)
  getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]>; // SchedulerTaskQueue (status: waiting)
  getArchivedTasks(limit: number, offset: number): Promise<SchedulerTaskRecord[]>;
  getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null>; // FIFO by createdAt
  getOverdueScheduledTasks(): Promise<SchedulerTaskRecord[]>; // status: scheduled AND scheduledTime < now

  // Scheduler state
  getSchedulerState(): Promise<SchedulerState>;
  setSchedulerState(state: Partial<SchedulerState>): Promise<void>;

  // Task counts
  getTaskCounts(): Promise<SchedulerTaskCounts>;
}

// ============================================================================
// Alarms Interface
// ============================================================================

/**
 * Alarm name prefix for scheduled tasks.
 * Format: scheduler-task-{taskId}
 */
export const SCHEDULER_ALARM_PREFIX = 'scheduler-task-';

/**
 * Alarm name for SchedulerTaskQueue processing check.
 * Fires periodically to process tasks in the SchedulerTaskQueue (waiting status).
 */
export const SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM = 'scheduler-task-queue-processor';

/**
 * Alarm configuration
 */
export interface SchedulerAlarmConfig {
  /** Interval for SchedulerTaskQueue processor alarm (minutes) */
  schedulerTaskQueueProcessorInterval: number;

  /** Minimum delay before task execution (ms) - chrome.alarms minimum is 1 minute */
  minScheduleDelay: number;
}

export const DEFAULT_ALARM_CONFIG: SchedulerAlarmConfig = {
  schedulerTaskQueueProcessorInterval: 1, // 1 minute
  minScheduleDelay: 60000, // 1 minute (chrome.alarms minimum)
};

/**
 * Alarms operations interface
 */
export interface ISchedulerAlarms {
  /**
   * Create an alarm for a scheduled task.
   * @param taskId - The task ID
   * @param scheduledTime - Unix timestamp when task should execute
   */
  createTaskAlarm(taskId: string, scheduledTime: number): Promise<void>;

  /**
   * Clear an alarm for a scheduled task (e.g., when cancelled).
   * @param taskId - The task ID
   */
  clearTaskAlarm(taskId: string): Promise<void>;

  /**
   * Check if an alarm exists for a task.
   * @param taskId - The task ID
   */
  hasTaskAlarm(taskId: string): Promise<boolean>;

  /**
   * Start the SchedulerTaskQueue processor alarm.
   * Called on extension startup. Periodically checks for tasks to execute.
   */
  startSchedulerTaskQueueProcessor(): Promise<void>;

  /**
   * Stop the SchedulerTaskQueue processor alarm.
   * Called when scheduler is paused.
   */
  stopSchedulerTaskQueueProcessor(): Promise<void>;

  /**
   * Get all active scheduler alarms.
   */
  getAllAlarms(): Promise<SchedulerAlarm[]>;
}

/**
 * Alarm event types
 */
export type SchedulerAlarmEvent =
  | { type: 'task'; taskId: string }
  | { type: 'scheduler-task-queue-processor' };

/**
 * Parse alarm name to determine event type.
 */
export function parseAlarmName(alarmName: string): SchedulerAlarmEvent | null {
  if (alarmName === SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM) {
    return { type: 'scheduler-task-queue-processor' };
  }
  if (alarmName.startsWith(SCHEDULER_ALARM_PREFIX)) {
    const taskId = alarmName.slice(SCHEDULER_ALARM_PREFIX.length);
    return { type: 'task', taskId };
  }
  return null;
}

/**
 * Generate alarm name for a task.
 */
export function getTaskAlarmName(taskId: string): string {
  return `${SCHEDULER_ALARM_PREFIX}${taskId}`;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Scheduler message types for UI-background communication
 */
export enum SchedulerMessageType {
  // Task Management
  CREATE_DRAFT_TASK = 'CREATE_DRAFT_TASK',
  SCHEDULE_TASK = 'SCHEDULE_TASK',
  TRIGGER_TASK = 'TRIGGER_TASK', // Manually trigger draft/scheduled task
  CANCEL_TASK = 'CANCEL_TASK',

  // SchedulerTaskQueue Control
  PAUSE_SCHEDULER_TASK_QUEUE = 'PAUSE_SCHEDULER_TASK_QUEUE',
  RESUME_SCHEDULER_TASK_QUEUE = 'RESUME_SCHEDULER_TASK_QUEUE',

  // Queries
  GET_DRAFT_TASKS = 'GET_DRAFT_TASKS',
  GET_SCHEDULED_TASKS = 'GET_SCHEDULED_TASKS',
  GET_MISSED_TASKS = 'GET_MISSED_TASKS', // Tasks that missed their scheduled time
  GET_SCHEDULER_TASK_QUEUE = 'GET_SCHEDULER_TASK_QUEUE', // Tasks in waiting status
  GET_ARCHIVED_TASKS = 'GET_ARCHIVED_TASKS',
  GET_SCHEDULER_STATE = 'GET_SCHEDULER_STATE',
  GET_TASK_DETAILS = 'GET_TASK_DETAILS',

  // Events (background -> UI)
  TASK_STATUS_CHANGED = 'TASK_STATUS_CHANGED',
  SCHEDULER_STATE_CHANGED = 'SCHEDULER_STATE_CHANGED',
}

// ============================================================================
// Request Payloads
// ============================================================================

export interface CreateDraftTaskRequest {
  input: string;
}

export interface ScheduleTaskRequest {
  input?: string; // For new task with time
  taskId?: string; // For scheduling existing draft
  scheduledTime: number; // Unix timestamp in ms
}

export interface TriggerTaskRequest {
  taskId: string; // Manually trigger a draft or scheduled task
}

export interface CancelTaskRequest {
  taskId: string;
}

export interface GetTaskDetailsRequest {
  taskId: string;
}

export interface GetArchivedTasksRequest {
  limit?: number; // Default: 50
  offset?: number; // Default: 0
}

// ============================================================================
// Response Payloads
// ============================================================================

export interface CreateDraftTaskResponse {
  success: boolean;
  taskId?: string;
  error?: string;
}

export interface ScheduleTaskResponse {
  success: boolean;
  taskId?: string;
  error?: string;
}

export interface TriggerTaskResponse {
  success: boolean;
  error?: string;
}

export interface CancelTaskResponse {
  success: boolean;
  error?: string;
}

export interface GetDraftTasksResponse {
  tasks: SchedulerTaskSummary[];
}

export interface GetScheduledTasksResponse {
  tasks: SchedulerTaskSummary[];
}

export interface GetMissedTasksResponse {
  tasks: SchedulerTaskSummary[]; // Tasks with 'missed' status
}

export interface GetSchedulerTaskQueueResponse {
  tasks: SchedulerTaskSummary[]; // Tasks in 'waiting' status (FIFO)
}

export interface GetArchivedTasksResponse {
  tasks: ArchivedTaskSummary[];
  total: number;
  hasMore: boolean;
}

export interface GetSchedulerStateResponse {
  isPaused: boolean;
  currentTaskId: string | null;
  draftCount: number; // Tasks without scheduled time
  scheduledCount: number; // Tasks waiting for their scheduled time
  missedCount: number; // Tasks that missed their scheduled time (requires user action)
  schedulerTaskQueueCount: number; // Tasks in SchedulerTaskQueue (waiting status)
  runningTask: SchedulerTaskSummary | null;
}

export interface GetTaskDetailsResponse {
  task: SchedulerTaskFull | null;
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface TaskStatusChangedEvent {
  taskId: string;
  previousStatus: SchedulerTaskStatus;
  newStatus: SchedulerTaskStatus;
  timestamp: number;
}

export interface SchedulerStateChangedEvent {
  isPaused: boolean;
  currentTaskId: string | null;
}

// ============================================================================
// Shared Types for Messages
// ============================================================================

export interface SchedulerTaskSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number | null; // Null for draft tasks
  status: SchedulerTaskStatus;
  createdAt: number;
}

export interface ArchivedTaskSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number | null;
  completedAt: number;
  status: 'completed' | 'failed';
  sessionId: string | null;
  error?: string;
}

export interface SchedulerTaskFull {
  id: string;
  input: string;
  scheduledTime: number | null; // Null for draft tasks
  createdAt: number;
  status: SchedulerTaskStatus;
  sessionId: string | null;
  completedAt: number | null;
  error: string | null;
}

// ============================================================================
// IndexedDB Schema Constants
// ============================================================================

export const SCHEDULER_TASKS_STORE = 'scheduler_tasks';

export const SCHEDULER_TASKS_INDEXES = [
  { name: 'by_status', keyPath: 'status', unique: false },
  { name: 'by_scheduled_time', keyPath: 'scheduledTime', unique: false },
  { name: 'by_status_time', keyPath: ['status', 'scheduledTime'], unique: false },
  { name: 'by_created_at', keyPath: 'createdAt', unique: false },
] as const;

export const SCHEDULER_STATE_KEY = 'scheduler_state';
