/**
 * Task Management System Types
 *
 * Data model for persistent task tracking with DAG dependencies.
 *
 * @module core/taskmanager/types
 */

/**
 * Task lifecycle status
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/**
 * A tracked task within a session plan
 */
export interface Task {
  /** Auto-increment ID, never resets: "1", "4", "7" */
  id: string;
  /** Imperative title ("Fix auth bug") */
  subject: string;
  /** Detailed requirements */
  task_description: string;
  /** Present continuous form for UI spinner ("Fixing auth bug") */
  activeForm?: string;
  /** Current lifecycle status */
  status: TaskStatus;
  /** Agent name (for future multi-agent) */
  owner?: string;
  /** Arbitrary key-value metadata */
  metadata?: Record<string, unknown>;
  /** Task IDs that cannot start until this completes */
  blocks: string[];
  /** Task IDs that must complete before this can start */
  blockedBy: string[];
}

/**
 * Lightweight task summary for list views
 */
export interface TaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  /** Only open (non-completed, non-deleted) blocker IDs */
  blockedBy: string[];
}

/**
 * Storage blob — one record per session
 */
export interface SessionPlanData {
  /** Storage key */
  sessionId: string;
  /** Auto-increment counter (never resets) */
  nextTaskId: number;
  /** One-line summary of the plan goal */
  plan_summary?: string;
  /** Free-form strategy: approach, reasoning, constraints (markdown) */
  plan_detail?: string;
  /** Current plan's tasks */
  tasks: Task[];
  /** When current plan was created (ISO 8601) */
  createdAt: string;
  /** Last modification (ISO 8601) */
  updatedAt: string;
}

/**
 * Available planning commands
 */
export type PlanningCommand = 'plan' | 'update' | 'list' | 'get' | 'get_plan';
