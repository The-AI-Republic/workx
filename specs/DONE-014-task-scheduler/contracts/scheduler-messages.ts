/**
 * Scheduler Message Contracts
 *
 * Message types for communication between sidepanel UI and background service worker.
 * Follows existing MessageRouter patterns from src/core/MessageRouter.ts
 */

// ============================================================================
// Message Types (extend existing MessageType enum)
// ============================================================================

export enum SchedulerMessageType {
  // Task Management
  CREATE_DRAFT_TASK = 'CREATE_DRAFT_TASK',
  SCHEDULE_TASK = 'SCHEDULE_TASK',
  TRIGGER_TASK = 'TRIGGER_TASK',  // Manually trigger draft/scheduled task
  CANCEL_TASK = 'CANCEL_TASK',

  // SchedulerTaskQueue Control
  PAUSE_SCHEDULER_TASK_QUEUE = 'PAUSE_SCHEDULER_TASK_QUEUE',
  RESUME_SCHEDULER_TASK_QUEUE = 'RESUME_SCHEDULER_TASK_QUEUE',

  // Queries
  GET_DRAFT_TASKS = 'GET_DRAFT_TASKS',
  GET_SCHEDULED_TASKS = 'GET_SCHEDULED_TASKS',
  GET_MISSED_TASKS = 'GET_MISSED_TASKS',  // Tasks that missed their scheduled time
  GET_SCHEDULER_TASK_QUEUE = 'GET_SCHEDULER_TASK_QUEUE',  // Tasks in waiting status
  GET_ARCHIVED_TASKS = 'GET_ARCHIVED_TASKS',
  GET_SCHEDULER_STATE = 'GET_SCHEDULER_STATE',
  GET_TASK_DETAILS = 'GET_TASK_DETAILS',

  // Events (background → UI)
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
  input?: string;              // For new task with time
  taskId?: string;             // For scheduling existing draft
  scheduledTime: number;       // Unix timestamp in ms
}

export interface TriggerTaskRequest {
  taskId: string;              // Manually trigger a draft or scheduled task
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
  tasks: SchedulerTaskSummary[];  // Tasks with 'missed' status
}

export interface GetSchedulerTaskQueueResponse {
  tasks: SchedulerTaskSummary[];  // Tasks in 'waiting' status (FIFO)
}

export interface GetArchivedTasksResponse {
  tasks: ArchivedTaskSummary[];
  total: number;
  hasMore: boolean;
}

export interface GetSchedulerStateResponse {
  isPaused: boolean;
  currentTaskId: string | null;
  draftCount: number;                  // Tasks without scheduled time
  scheduledCount: number;              // Tasks waiting for their scheduled time
  missedCount: number;                 // Tasks that missed their scheduled time (requires user action)
  schedulerTaskQueueCount: number;     // Tasks in SchedulerTaskQueue (waiting status)
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
// Shared Types
// ============================================================================

export type SchedulerTaskStatus =
  | 'draft'      // Task created, no scheduled time set
  | 'scheduled'  // Has scheduled time, alarm is set
  | 'missed'     // Scheduled time passed while browser was closed, awaiting user action
  | 'waiting'    // In SchedulerTaskQueue - triggered but blocked by running task
  | 'running'    // Currently executing
  | 'completed'  // Successfully finished
  | 'failed'     // Execution failed
  | 'cancelled'; // User cancelled

export interface SchedulerTaskSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number | null;  // Null for draft tasks
  status: SchedulerTaskStatus;
  createdAt: number;
}

export interface ArchivedTaskSummary {
  id: string;
  input: string; // First 100 chars
  scheduledTime: number;
  completedAt: number;
  status: 'completed' | 'failed';
  sessionId: string | null;
  error?: string;
}

export interface SchedulerTaskFull {
  id: string;
  input: string;
  scheduledTime: number | null;  // Null for draft tasks
  createdAt: number;
  status: SchedulerTaskStatus;
  sessionId: string | null;
  completedAt: number | null;
  error: string | null;
}
