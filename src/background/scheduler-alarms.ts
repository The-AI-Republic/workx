/**
 * Scheduler Alarms
 *
 * Chrome alarms API wrapper for persistent task scheduling.
 * Handles task alarms and SchedulerTaskQueue processor alarm.
 */

import type { ISchedulerAlarms, SchedulerAlarmConfig } from '../models/types/SchedulerContracts';
import {
  SCHEDULER_ALARM_PREFIX,
  SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM,
  DEFAULT_ALARM_CONFIG,
  getTaskAlarmName,
} from '../models/types/SchedulerContracts';

/**
 * SchedulerAlarms - manages Chrome alarms for task scheduling
 */
export class SchedulerAlarms implements ISchedulerAlarms {
  private config: SchedulerAlarmConfig;

  constructor(config: Partial<SchedulerAlarmConfig> = {}) {
    this.config = {
      ...DEFAULT_ALARM_CONFIG,
      ...config,
    };
  }

  /**
   * Create an alarm for a scheduled task
   * @param taskId - The task ID
   * @param scheduledTime - Unix timestamp (ms) when task should execute
   */
  async createTaskAlarm(taskId: string, scheduledTime: number): Promise<void> {
    const alarmName = getTaskAlarmName(taskId);
    const now = Date.now();

    // Chrome alarms have a minimum of 1 minute
    // If scheduled time is less than 1 minute away, set alarm for 1 minute
    // The task will execute immediately when the alarm fires
    const delayMs = Math.max(scheduledTime - now, this.config.minScheduleDelay);

    // Convert to minutes for chrome.alarms API
    const delayMinutes = delayMs / 60000;

    return new Promise((resolve, reject) => {
      chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to create alarm: ${chrome.runtime.lastError.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Clear an alarm for a scheduled task
   * @param taskId - The task ID
   */
  async clearTaskAlarm(taskId: string): Promise<void> {
    const alarmName = getTaskAlarmName(taskId);

    return new Promise((resolve, reject) => {
      chrome.alarms.clear(alarmName, (wasCleared) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to clear alarm: ${chrome.runtime.lastError.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Check if an alarm exists for a task
   * @param taskId - The task ID
   */
  async hasTaskAlarm(taskId: string): Promise<boolean> {
    const alarmName = getTaskAlarmName(taskId);

    return new Promise((resolve, reject) => {
      chrome.alarms.get(alarmName, (alarm) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to get alarm: ${chrome.runtime.lastError.message}`));
        } else {
          resolve(alarm !== undefined);
        }
      });
    });
  }

  /**
   * Start the SchedulerTaskQueue processor alarm
   * Fires periodically to check for tasks that need processing
   */
  async startSchedulerTaskQueueProcessor(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.alarms.create(
        SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM,
        {
          periodInMinutes: this.config.schedulerTaskQueueProcessorInterval,
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                `Failed to start queue processor: ${chrome.runtime.lastError.message}`
              )
            );
          } else {
            resolve();
          }
        }
      );
    });
  }

  /**
   * Stop the SchedulerTaskQueue processor alarm
   */
  async stopSchedulerTaskQueueProcessor(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.alarms.clear(SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM, (wasCleared) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              `Failed to stop queue processor: ${chrome.runtime.lastError.message}`
            )
          );
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get all active scheduler alarms
   */
  async getAllAlarms(): Promise<chrome.alarms.Alarm[]> {
    return new Promise((resolve, reject) => {
      chrome.alarms.getAll((alarms) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to get alarms: ${chrome.runtime.lastError.message}`));
        } else {
          // Filter to only scheduler-related alarms
          const schedulerAlarms = alarms.filter(
            (alarm) =>
              alarm.name.startsWith(SCHEDULER_ALARM_PREFIX) ||
              alarm.name === SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM
          );
          resolve(schedulerAlarms);
        }
      });
    });
  }

  /**
   * Clear all scheduler alarms (useful for cleanup/reset)
   */
  async clearAllAlarms(): Promise<void> {
    const alarms = await this.getAllAlarms();
    await Promise.all(
      alarms.map(
        (alarm) =>
          new Promise<void>((resolve, reject) => {
            chrome.alarms.clear(alarm.name, (wasCleared) => {
              if (chrome.runtime.lastError) {
                reject(
                  new Error(`Failed to clear alarm: ${chrome.runtime.lastError.message}`)
                );
              } else {
                resolve();
              }
            });
          })
      )
    );
  }

  /**
   * Check if the SchedulerTaskQueue processor is running
   */
  async isSchedulerTaskQueueProcessorRunning(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      chrome.alarms.get(SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM, (alarm) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              `Failed to check queue processor: ${chrome.runtime.lastError.message}`
            )
          );
        } else {
          resolve(alarm !== undefined);
        }
      });
    });
  }
}
