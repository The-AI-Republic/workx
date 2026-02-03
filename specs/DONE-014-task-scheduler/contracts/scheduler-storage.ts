/**
 * Scheduler Storage Contracts
 *
 * Interfaces for IndexedDB and chrome.storage.local persistence.
 */

// ============================================================================
// IndexedDB: scheduler_tasks store
// ============================================================================

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

export type SchedulerTaskStatus =
  | 'draft'      // Task created, no scheduled time set
  | 'scheduled'  // Has scheduled time, alarm is set
  | 'missed'     // Scheduled time passed while browser was closed, awaiting user action
  | 'waiting'    // In SchedulerTaskQueue - triggered but blocked by running task
  | 'running'    // Currently executing
  | 'completed'  // Successfully finished
  | 'failed'     // Execution failed
  | 'cancelled'; // User cancelled

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
// IndexedDB Schema Definition
// ============================================================================

export const SCHEDULER_TASKS_STORE = 'scheduler_tasks';

export const SCHEDULER_TASKS_INDEXES = [
  { name: 'by_status', keyPath: 'status', unique: false },
  { name: 'by_scheduled_time', keyPath: 'scheduledTime', unique: false },
  { name: 'by_status_time', keyPath: ['status', 'scheduledTime'], unique: false },
  { name: 'by_created_at', keyPath: 'createdAt', unique: false },
] as const;

// ============================================================================
// chrome.storage.local: Quick access state
// ============================================================================

export interface SchedulerState {
  /** Whether SchedulerTaskQueue processing is paused */
  isPaused: boolean;

  /** ID of currently running task */
  currentTaskId: string | null;

  /** Timestamp of last SchedulerTaskQueue processing */
  lastProcessedTime: number;
}

export const SCHEDULER_STATE_KEY = 'scheduler_state';

// ============================================================================
// Storage Operations Interface
// ============================================================================

export interface ISchedulerStorage {
  // Task CRUD
  createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord>;  // No time = draft
  getTask(id: string): Promise<SchedulerTaskRecord | null>;
  updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void>;
  deleteTask(id: string): Promise<void>;

  // Queries
  getDraftTasks(): Promise<SchedulerTaskRecord[]>;                    // Tasks without time (status: draft)
  getScheduledTasks(): Promise<SchedulerTaskRecord[]>;                // Upcoming (status: scheduled)
  getMissedTasks(): Promise<SchedulerTaskRecord[]>;                   // Overdue tasks (status: missed)
  getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]>;       // SchedulerTaskQueue (status: waiting)
  getArchivedTasks(limit: number, offset: number): Promise<SchedulerTaskRecord[]>;
  getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null>;  // FIFO by createdAt
  getOverdueScheduledTasks(): Promise<SchedulerTaskRecord[]>;         // status: scheduled AND scheduledTime < now

  // Scheduler state
  getSchedulerState(): Promise<SchedulerState>;
  setSchedulerState(state: Partial<SchedulerState>): Promise<void>;
}
