/**
 * Scheduler Alarms
 *
 * Chrome alarms API wrapper for persistent job scheduling.
 * Handles job alarms and job queue processor alarm.
 */

import type { ISchedulerAlarms, SchedulerAlarmConfig, SchedulerAlarm } from '../../core/models/types/SchedulerContracts';
import {
  SCHEDULER_ALARM_PREFIX,
  SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
  DEFAULT_ALARM_CONFIG,
  getJobAlarmName,
} from '../../core/models/types/SchedulerContracts';

/**
 * SchedulerAlarms - manages Chrome alarms for job scheduling
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
   * Create an alarm for a scheduled job
   * @param jobId - The job ID
   * @param scheduledTime - Unix timestamp (ms) when job should execute
   */
  async createJobAlarm(jobId: string, scheduledTime: number): Promise<void> {
    const alarmName = getJobAlarmName(jobId);
    const now = Date.now();

    // Chrome alarms have a minimum of 1 minute
    // If scheduled time is less than 1 minute away, set alarm for 1 minute
    // The job will execute immediately when the alarm fires
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
   * Clear an alarm for a scheduled job
   * @param jobId - The job ID
   */
  async clearJobAlarm(jobId: string): Promise<void> {
    const alarmName = getJobAlarmName(jobId);

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
   * Check if an alarm exists for a job
   * @param jobId - The job ID
   */
  async hasJobAlarm(jobId: string): Promise<boolean> {
    const alarmName = getJobAlarmName(jobId);

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
   * Start the job queue processor alarm
   * Fires periodically to check for jobs that need processing
   */
  async startJobQueueProcessor(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.alarms.create(
        SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
        {
          periodInMinutes: this.config.jobQueueProcessorInterval,
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
   * Stop the job queue processor alarm
   */
  async stopJobQueueProcessor(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.alarms.clear(SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM, (wasCleared) => {
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
  async getAllAlarms(): Promise<SchedulerAlarm[]> {
    return new Promise((resolve, reject) => {
      chrome.alarms.getAll((alarms) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to get alarms: ${chrome.runtime.lastError.message}`));
        } else {
          // Filter to only scheduler-related alarms
          const schedulerAlarms = alarms.filter(
            (alarm) =>
              alarm.name.startsWith(SCHEDULER_ALARM_PREFIX) ||
              alarm.name === SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM
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
   * Check if the job queue processor is running
   */
  async isJobQueueProcessorRunning(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      chrome.alarms.get(SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM, (alarm) => {
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
