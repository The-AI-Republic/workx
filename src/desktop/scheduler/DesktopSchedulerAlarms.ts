/**
 * Desktop Scheduler Alarms
 *
 * Hybrid ISchedulerAlarms implementation for desktop (Tauri) mode.
 * Combines in-process timers (precise, while app is running) with
 * OS-level jobs via Tauri commands (persistent across full app quit).
 *
 * Natural deduplication: whichever fires first wins —
 * scheduler.handleAlarm() checks task status before executing.
 *
 * @module desktop/scheduler/DesktopSchedulerAlarms
 */

import type {
  ISchedulerAlarms,
  SchedulerAlarmConfig,
  SchedulerAlarm,
} from '../../core/models/types/SchedulerContracts';
import {
  DEFAULT_ALARM_CONFIG,
  getTaskAlarmName,
  SCHEDULER_ALARM_PREFIX,
  SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM,
} from '../../core/models/types/SchedulerContracts';

/**
 * Alarm handler callback
 */
export type AlarmHandler = (alarmName: string) => Promise<void>;

/**
 * Internal timer metadata
 */
interface TimerEntry {
  timer: ReturnType<typeof setTimeout>;
  alarm: SchedulerAlarm;
}

export class DesktopSchedulerAlarms implements ISchedulerAlarms {
  private config: SchedulerAlarmConfig;
  private timers = new Map<string, TimerEntry>();
  private queueProcessorTimer: ReturnType<typeof setInterval> | null = null;
  private alarmHandler: AlarmHandler | null = null;

  constructor(config: Partial<SchedulerAlarmConfig> = {}) {
    this.config = {
      ...DEFAULT_ALARM_CONFIG,
      // Desktop has no minimum delay constraint
      minScheduleDelay: 0,
      ...config,
    };
  }

  /**
   * Set the alarm handler callback.
   */
  setAlarmHandler(handler: AlarmHandler): void {
    this.alarmHandler = handler;
  }

  /**
   * Create both an in-process timer and an OS-level job for a task.
   */
  async createTaskAlarm(taskId: string, scheduledTime: number): Promise<void> {
    const alarmName = getTaskAlarmName(taskId);
    const now = Date.now();
    const delayMs = Math.max(scheduledTime - now, 0);

    // Clear any existing timer for this task
    this.clearTimerEntry(alarmName);

    // 1. In-process timer (precise, fires while app is running)
    const timer = setTimeout(async () => {
      this.timers.delete(alarmName);
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(alarmName);
        } catch (error) {
          console.error(`[DesktopSchedulerAlarms] Error handling alarm ${alarmName}:`, error);
        }
      }
    }, delayMs);

    this.timers.set(alarmName, {
      timer,
      alarm: {
        name: alarmName,
        scheduledTime,
      },
    });

    // 2. OS-level job (persistent across full app quit)
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('scheduler_register_os_job', {
        taskId,
        scheduledTime,
      });
    } catch (error) {
      console.warn('[DesktopSchedulerAlarms] Failed to register OS job (app will handle in-process):', error);
    }
  }

  /**
   * Clear both the in-process timer and OS-level job.
   */
  async clearTaskAlarm(taskId: string): Promise<void> {
    const alarmName = getTaskAlarmName(taskId);
    this.clearTimerEntry(alarmName);

    // Remove OS-level job
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('scheduler_remove_os_job', { taskId });
    } catch (error) {
      console.warn('[DesktopSchedulerAlarms] Failed to remove OS job:', error);
    }
  }

  /**
   * Check if a timer exists for a task.
   */
  async hasTaskAlarm(taskId: string): Promise<boolean> {
    const alarmName = getTaskAlarmName(taskId);
    return this.timers.has(alarmName);
  }

  /**
   * Start the queue processor interval timer (in-process only).
   */
  async startSchedulerTaskQueueProcessor(): Promise<void> {
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
    }

    const intervalMs = this.config.schedulerTaskQueueProcessorInterval * 60000;

    this.queueProcessorTimer = setInterval(async () => {
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM);
        } catch (error) {
          console.error('[DesktopSchedulerAlarms] Error in queue processor:', error);
        }
      }
    }, intervalMs);
  }

  /**
   * Stop the queue processor interval timer.
   */
  async stopSchedulerTaskQueueProcessor(): Promise<void> {
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }
  }

  /**
   * Get all active scheduler alarms.
   */
  async getAllAlarms(): Promise<SchedulerAlarm[]> {
    const alarms: SchedulerAlarm[] = [];

    for (const entry of this.timers.values()) {
      alarms.push(entry.alarm);
    }

    if (this.queueProcessorTimer) {
      alarms.push({
        name: SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM,
        scheduledTime: Date.now(),
        periodInMinutes: this.config.schedulerTaskQueueProcessorInterval,
      });
    }

    return alarms;
  }

  /**
   * Reconcile OS jobs with in-process timers on app startup.
   * - List OS jobs
   * - Recreate in-process timers for pending tasks
   * - Clean stale OS jobs (tasks that no longer exist)
   */
  async reconcileOnStartup(
    getScheduledTasks: () => Promise<Array<{ id: string; scheduledTime: number | null }>>
  ): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // Get OS jobs
      const osJobIds = await invoke<string[]>('scheduler_list_os_jobs');

      // Get scheduled tasks from storage
      const tasks = await getScheduledTasks();
      const taskMap = new Map(tasks.map(t => [t.id, t]));

      // Recreate in-process timers for valid tasks
      for (const taskId of osJobIds) {
        const task = taskMap.get(taskId);
        if (task && task.scheduledTime && task.scheduledTime > Date.now()) {
          // Task is still valid — create in-process timer
          const alarmName = getTaskAlarmName(taskId);
          const delayMs = task.scheduledTime - Date.now();

          const timer = setTimeout(async () => {
            this.timers.delete(alarmName);
            if (this.alarmHandler) {
              try {
                await this.alarmHandler(alarmName);
              } catch (error) {
                console.error(`[DesktopSchedulerAlarms] Error handling alarm ${alarmName}:`, error);
              }
            }
          }, delayMs);

          this.timers.set(alarmName, {
            timer,
            alarm: { name: alarmName, scheduledTime: task.scheduledTime },
          });
        } else {
          // Task no longer exists or is past — clean up OS job
          try {
            await invoke('scheduler_remove_os_job', { taskId });
          } catch {
            // Non-fatal
          }
        }
      }

      console.log(`[DesktopSchedulerAlarms] Reconciled ${osJobIds.length} OS jobs`);
    } catch (error) {
      console.warn('[DesktopSchedulerAlarms] Could not reconcile OS jobs:', error);
    }
  }

  /**
   * Dispose all timers (in-process only — OS jobs persist intentionally).
   */
  dispose(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.timer);
    }
    this.timers.clear();

    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }

    console.log('[DesktopSchedulerAlarms] All in-process timers cleared');
  }

  /**
   * Clear a single timer entry by name.
   */
  private clearTimerEntry(name: string): void {
    const entry = this.timers.get(name);
    if (entry) {
      clearTimeout(entry.timer);
      this.timers.delete(name);
    }
  }
}
