/**
 * Scheduler
 *
 * Main orchestrator class for the Task Scheduler feature.
 * Manages task lifecycle: creation, scheduling, execution, and completion.
 */

import { v4 as uuidv4 } from 'uuid';
import type { SchedulerStorage } from './SchedulerStorage';
import type { SchedulerAlarms } from '../../background/scheduler-alarms';
import type {
  SchedulerTaskRecord,
  SchedulerTaskStatus,
  TaskResultRecord,
} from '../../models/types/Scheduler';
import type {
  ISchedulerStorage,
  ISchedulerAlarms,
  TaskStatusChangedEvent,
  SchedulerStateChangedEvent,
  SchedulerTaskSummary,
  GetSchedulerStateResponse,
} from '../../models/types/SchedulerContracts';
import {
  parseAlarmName,
  DEFAULT_ALARM_CONFIG,
} from '../../models/types/SchedulerContracts';

/**
 * Event emitter type for scheduler events
 */
export type SchedulerEventEmitter = (
  event: TaskStatusChangedEvent | SchedulerStateChangedEvent
) => void;

/**
 * Scheduler - main orchestrator for scheduled task execution
 */
export class Scheduler {
  private eventEmitter: SchedulerEventEmitter | null = null;

  constructor(
    private storage: ISchedulerStorage,
    private alarms: ISchedulerAlarms
  ) {}

  /**
   * Set event emitter for status change notifications
   */
  setEventEmitter(emitter: SchedulerEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /**
   * Create a draft task (no scheduled time)
   * @returns The created task ID
   */
  async createDraftTask(input: string): Promise<string> {
    const task = await this.storage.createTask(input);
    return task.id;
  }

  /**
   * Schedule a new task for future execution
   * @returns The created task ID
   */
  async scheduleTask(input: string, scheduledTime: number): Promise<string> {
    // Validate scheduled time is in the future
    const now = Date.now();
    if (scheduledTime <= now) {
      throw new Error('Scheduled time must be in the future');
    }

    // Create the task with scheduled status
    const task = await this.storage.createTask(input, scheduledTime);

    // Create alarm for the task
    await this.alarms.createTaskAlarm(task.id, scheduledTime);

    return task.id;
  }

  /**
   * Schedule an existing draft task
   */
  async scheduleExistingTask(taskId: string, scheduledTime: number): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== 'draft') {
      throw new Error(`Cannot schedule task in ${task.status} status`);
    }

    // Validate scheduled time is in the future
    const now = Date.now();
    if (scheduledTime <= now) {
      throw new Error('Scheduled time must be in the future');
    }

    const previousStatus = task.status;

    // Update task with scheduled time and status
    await this.storage.updateTask(taskId, {
      scheduledTime,
      status: 'scheduled',
    });

    // Create alarm for the task
    await this.alarms.createTaskAlarm(taskId, scheduledTime);

    // Emit status change event
    this.emitStatusChange(taskId, previousStatus, 'scheduled');
  }

  /**
   * Manually trigger a task (draft or scheduled)
   * If another task is running, adds to SchedulerTaskQueue
   */
  async triggerTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Only draft, scheduled, or missed tasks can be triggered
    if (!['draft', 'scheduled', 'missed'].includes(task.status)) {
      throw new Error(`Cannot trigger task in ${task.status} status`);
    }

    const previousStatus = task.status;

    // Clear alarm if task was scheduled
    if (task.status === 'scheduled') {
      await this.alarms.clearTaskAlarm(taskId);
    }

    // Check if another task is currently running
    const state = await this.storage.getSchedulerState();
    if (state.currentTaskId) {
      // Add to SchedulerTaskQueue
      await this.storage.updateTask(taskId, { status: 'waiting' });
      this.emitStatusChange(taskId, previousStatus, 'waiting');
    } else {
      // Execute immediately
      await this.executeTask(taskId);
    }
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Cannot cancel completed or failed tasks
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      throw new Error(`Cannot cancel task in ${task.status} status`);
    }

    const previousStatus = task.status;

    // Clear alarm if scheduled
    if (task.status === 'scheduled') {
      await this.alarms.clearTaskAlarm(taskId);
    }

    // If task is running, need to abort execution
    if (task.status === 'running') {
      // Clear current task from state
      await this.storage.setSchedulerState({ currentTaskId: null });
      this.emitStateChange();
    }

    // Update task status
    await this.storage.updateTask(taskId, {
      status: 'cancelled',
      completedAt: Date.now(),
    });

    this.emitStatusChange(taskId, previousStatus, 'cancelled');

    // Process queue if we cancelled the running task
    if (previousStatus === 'running') {
      await this.processSchedulerTaskQueue();
    }
  }

  /**
   * Execute a task
   * Opens a new browser tab with the task for execution
   */
  async executeTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const previousStatus = task.status;

    // Generate a new session ID for this task
    const sessionId = uuidv4();

    // Update task to running status
    await this.storage.updateTask(taskId, {
      status: 'running',
      sessionId,
    });

    // Update scheduler state
    await this.storage.setSchedulerState({
      currentTaskId: taskId,
      lastProcessedTime: Date.now(),
    });

    this.emitStatusChange(taskId, previousStatus, 'running');
    this.emitStateChange();

    // Show browser notification (T025)
    await this.showTaskStartNotification(task);

    // Open a new browser tab for task execution
    await this.openSchedulerTaskTab(taskId, sessionId);
  }

  /**
   * Show browser notification when a scheduled task starts
   */
  private async showTaskStartNotification(task: SchedulerTaskRecord): Promise<void> {
    try {
      const inputPreview = task.input.length > 50
        ? task.input.slice(0, 50) + '...'
        : task.input;

      await chrome.notifications.create(`scheduler-task-${task.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Scheduled Task Starting',
        message: inputPreview,
        priority: 2,
        requireInteraction: false,
      });
    } catch (error) {
      // Notification permission may not be granted - log and continue
      console.warn('[Scheduler] Failed to show notification:', error);
    }
  }

  /**
   * Open a new browser tab for scheduled task execution
   */
  private async openSchedulerTaskTab(taskId: string, sessionId: string): Promise<void> {
    // Get the extension's sidepanel URL with scheduled task parameters
    const extensionUrl = chrome.runtime.getURL(
      `sidepanel/index.html?scheduledTask=${taskId}&sessionId=${sessionId}`
    );

    // Create a new tab with the sidepanel page
    await chrome.tabs.create({
      url: extensionUrl,
      active: true,
    });
  }

  /**
   * Mark a task as completed
   * Called by the executing tab when task finishes successfully
   */
  async completeTask(
    taskId: string,
    result: TaskResultRecord
  ): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== 'running') {
      throw new Error(`Cannot complete task in ${task.status} status`);
    }

    const previousStatus = task.status;

    // Update task with completion info
    await this.storage.updateTask(taskId, {
      status: 'completed',
      completedAt: Date.now(),
      result,
    });

    // Clear current task from state
    await this.storage.setSchedulerState({ currentTaskId: null });

    this.emitStatusChange(taskId, previousStatus, 'completed');
    this.emitStateChange();

    // Process next task in queue
    await this.processSchedulerTaskQueue();
  }

  /**
   * Mark a task as failed
   * Called by the executing tab when task encounters an error
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== 'running') {
      throw new Error(`Cannot fail task in ${task.status} status`);
    }

    const previousStatus = task.status;

    // Update task with failure info
    await this.storage.updateTask(taskId, {
      status: 'failed',
      completedAt: Date.now(),
      error,
    });

    // Clear current task from state
    await this.storage.setSchedulerState({ currentTaskId: null });

    this.emitStatusChange(taskId, previousStatus, 'failed');
    this.emitStateChange();

    // Process next task in queue
    await this.processSchedulerTaskQueue();
  }

  /**
   * Process the SchedulerTaskQueue
   * Executes the next waiting task if no task is currently running
   */
  async processSchedulerTaskQueue(): Promise<void> {
    const state = await this.storage.getSchedulerState();

    // Don't process if paused
    if (state.isPaused) {
      return;
    }

    // Don't process if a task is already running
    if (state.currentTaskId) {
      return;
    }

    // Get next task from queue (FIFO)
    const nextTask = await this.storage.getNextTaskInSchedulerTaskQueue();
    if (nextTask) {
      await this.executeTask(nextTask.id);
    }
  }

  /**
   * Pause SchedulerTaskQueue processing
   */
  async pauseSchedulerTaskQueue(): Promise<void> {
    await this.storage.setSchedulerState({ isPaused: true });
    await this.alarms.stopSchedulerTaskQueueProcessor();
    this.emitStateChange();
  }

  /**
   * Resume SchedulerTaskQueue processing
   */
  async resumeSchedulerTaskQueue(): Promise<void> {
    await this.storage.setSchedulerState({ isPaused: false });
    await this.alarms.startSchedulerTaskQueueProcessor();
    this.emitStateChange();

    // Process queue immediately
    await this.processSchedulerTaskQueue();
  }

  /**
   * Handle alarm event from chrome.alarms
   */
  async handleAlarm(alarmName: string): Promise<void> {
    const event = parseAlarmName(alarmName);
    if (!event) {
      return;
    }

    if (event.type === 'task') {
      // Task alarm fired - trigger the task
      const task = await this.storage.getTask(event.taskId);
      if (task && task.status === 'scheduled') {
        await this.triggerTask(event.taskId);
      }
    } else if (event.type === 'scheduler-task-queue-processor') {
      // Queue processor alarm - process the queue
      await this.processSchedulerTaskQueue();
    }
  }

  /**
   * Detect and mark overdue tasks as missed
   * Called on browser startup
   */
  async detectMissedTasks(): Promise<SchedulerTaskRecord[]> {
    const overdueTasks = await this.storage.getOverdueScheduledTasks();

    for (const task of overdueTasks) {
      const previousStatus = task.status;
      await this.storage.updateTask(task.id, { status: 'missed' });
      await this.alarms.clearTaskAlarm(task.id);
      this.emitStatusChange(task.id, previousStatus, 'missed');
    }

    return overdueTasks;
  }

  /**
   * Get scheduler state for UI
   */
  async getSchedulerState(): Promise<GetSchedulerStateResponse> {
    const state = await this.storage.getSchedulerState();
    const counts = await (this.storage as SchedulerStorage).getTaskCounts();

    let runningTask: SchedulerTaskSummary | null = null;
    if (state.currentTaskId) {
      const task = await this.storage.getTask(state.currentTaskId);
      if (task) {
        runningTask = this.toTaskSummary(task);
      }
    }

    return {
      isPaused: state.isPaused,
      currentTaskId: state.currentTaskId,
      draftCount: counts.draftCount,
      scheduledCount: counts.scheduledCount,
      missedCount: counts.missedCount,
      schedulerTaskQueueCount: counts.waitingCount,
      runningTask,
    };
  }

  /**
   * Convert task record to summary for UI
   */
  private toTaskSummary(task: SchedulerTaskRecord): SchedulerTaskSummary {
    return {
      id: task.id,
      input: task.input.slice(0, 100),
      scheduledTime: task.scheduledTime,
      status: task.status,
      createdAt: task.createdAt,
    };
  }

  /**
   * Emit task status change event
   */
  private emitStatusChange(
    taskId: string,
    previousStatus: SchedulerTaskStatus,
    newStatus: SchedulerTaskStatus
  ): void {
    if (this.eventEmitter) {
      this.eventEmitter({
        taskId,
        previousStatus,
        newStatus,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Emit scheduler state change event
   */
  private async emitStateChange(): Promise<void> {
    if (this.eventEmitter) {
      const state = await this.storage.getSchedulerState();
      this.eventEmitter({
        isPaused: state.isPaused,
        currentTaskId: state.currentTaskId,
      });
    }
  }
}
