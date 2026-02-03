/**
 * Scheduler Alarms Contracts
 *
 * Chrome alarms API integration for persistent task scheduling.
 */

// ============================================================================
// Alarm Naming Convention
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

// ============================================================================
// Alarm Configuration
// ============================================================================

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

// ============================================================================
// Alarm Operations Interface
// ============================================================================

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
  getAllAlarms(): Promise<chrome.alarms.Alarm[]>;
}

// ============================================================================
// Alarm Event Types
// ============================================================================

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
