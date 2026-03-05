/**
 * Server Scheduler Alarms
 *
 * Node.js timer-based ISchedulerAlarms implementation for server mode.
 * Uses setTimeout/setInterval instead of Chrome Alarms API for job scheduling.
 *
 * Key differences from Chrome alarms:
 * - No minimum delay (Chrome has 1-minute minimum)
 * - Timers use .unref() to not block process shutdown
 * - Graceful shutdown() method to clear all timers
 *
 * @module server/scheduler/ServerSchedulerAlarms
 */

import type {
  ISchedulerAlarms,
  SchedulerAlarmConfig,
  SchedulerAlarm,
} from '../../core/models/types/SchedulerContracts';
import {
  DEFAULT_ALARM_CONFIG,
  getJobAlarmName,
  SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
} from '../../core/models/types/SchedulerContracts';

/** Maximum safe value for setTimeout delay (2^31 - 1 ms, ~24.8 days) */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Alarm handler callback — called when any timer fires
 */
export type AlarmHandler = (alarmName: string) => Promise<void>;

/**
 * Internal timer metadata
 */
interface TimerEntry {
  timer: NodeJS.Timeout;
  alarm: SchedulerAlarm;
}

export class ServerSchedulerAlarms implements ISchedulerAlarms {
  private config: SchedulerAlarmConfig;
  private timers = new Map<string, TimerEntry>();
  private queueProcessorTimer: NodeJS.Timeout | null = null;
  private alarmHandler: AlarmHandler | null = null;

  constructor(config: Partial<SchedulerAlarmConfig> = {}) {
    this.config = {
      ...DEFAULT_ALARM_CONFIG,
      // Server mode has no minimum delay constraint
      minScheduleDelay: 0,
      ...config,
    };
  }

  /**
   * Set the alarm handler callback.
   * Called when any timer fires — bridges to scheduler.handleAlarm().
   */
  setAlarmHandler(handler: AlarmHandler): void {
    this.alarmHandler = handler;
  }

  /**
   * Create a timer for a scheduled job.
   */
  async createJobAlarm(jobId: string, scheduledTime: number): Promise<void> {
    const alarmName = getJobAlarmName(jobId);

    // Clear any existing timer for this job
    this.clearTimerEntry(alarmName);

    const now = Date.now();
    const delayMs = Math.max(scheduledTime - now, 0);

    // Cap at MAX_TIMEOUT_MS to avoid setTimeout overflow; use a chained re-check if needed
    const clampedDelay = Math.min(delayMs, MAX_TIMEOUT_MS);
    const needsRecheck = delayMs > MAX_TIMEOUT_MS;

    const timer = setTimeout(async () => {
      if (needsRecheck && scheduledTime > Date.now()) {
        // Not yet time — re-arm the alarm
        this.timers.delete(alarmName);
        await this.createJobAlarm(jobId, scheduledTime);
        return;
      }
      this.timers.delete(alarmName);
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(alarmName);
        } catch (error) {
          console.error(`[ServerSchedulerAlarms] Error handling alarm ${alarmName}:`, error);
        }
      }
    }, clampedDelay);

    // Don't block process shutdown
    timer.unref();

    this.timers.set(alarmName, {
      timer,
      alarm: {
        name: alarmName,
        scheduledTime,
      },
    });
  }

  /**
   * Clear a timer for a scheduled job.
   */
  async clearJobAlarm(jobId: string): Promise<void> {
    const alarmName = getJobAlarmName(jobId);
    this.clearTimerEntry(alarmName);
  }

  /**
   * Check if a timer exists for a job.
   */
  async hasJobAlarm(jobId: string): Promise<boolean> {
    const alarmName = getJobAlarmName(jobId);
    return this.timers.has(alarmName);
  }

  /**
   * Start the queue processor interval timer.
   * Fires periodically to check for jobs that need processing.
   */
  async startJobQueueProcessor(): Promise<void> {
    // Clear existing if running
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
    }

    const intervalMs = this.config.jobQueueProcessorInterval * 60000;

    this.queueProcessorTimer = setInterval(async () => {
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM);
        } catch (error) {
          console.error('[ServerSchedulerAlarms] Error in queue processor:', error);
        }
      }
    }, intervalMs);

    // Don't block process shutdown
    this.queueProcessorTimer.unref();
  }

  /**
   * Stop the queue processor interval timer.
   */
  async stopJobQueueProcessor(): Promise<void> {
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

    // Include queue processor if running
    if (this.queueProcessorTimer) {
      alarms.push({
        name: SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
        scheduledTime: Date.now(), // Periodic — no fixed scheduled time
        periodInMinutes: this.config.jobQueueProcessorInterval,
      });
    }

    return alarms;
  }

  /**
   * Graceful shutdown — clear all timers.
   */
  shutdown(): void {
    // Clear all job timers
    for (const [name, entry] of this.timers) {
      clearTimeout(entry.timer);
    }
    this.timers.clear();

    // Clear queue processor
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }

    console.log('[ServerSchedulerAlarms] All timers cleared');
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
