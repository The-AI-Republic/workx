/**
 * Runtime-side scheduler alarms (Track 43 port of
 * src/desktop/scheduler/DesktopSchedulerAlarms.ts).
 *
 * Combines in-process timers (precise, while the runtime is running) with
 * OS-level scheduled jobs registered through the Rust scheduler control
 * frames (persistent across full app quit). Identical natural-dedupe
 * semantics: whichever fires first wins; `scheduler.handleAlarm()` checks
 * job status before executing.
 *
 * The WebView-side `DesktopSchedulerAlarms` is kept for now (it owns the
 * scheduler-deeplink listener path until that moves to a control frame),
 * but the agent uses this runtime version when running under
 * `profile='desktop-runtime'`.
 */

import type {
  ISchedulerAlarms,
  SchedulerAlarm,
  SchedulerAlarmConfig,
} from '@/core/models/types/SchedulerContracts';
import {
  DEFAULT_ALARM_CONFIG,
  getJobAlarmName,
  SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
} from '@/core/models/types/SchedulerContracts';
import type { SchedulerOsBridge } from '../protocol/controlBridge';

const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1; setTimeout max delay

export type AlarmHandler = (alarmName: string) => Promise<void>;

interface TimerEntry {
  timer: ReturnType<typeof setTimeout>;
  alarm: SchedulerAlarm;
}

export class RuntimeSchedulerAlarms implements ISchedulerAlarms {
  private readonly config: SchedulerAlarmConfig;
  private readonly timers = new Map<string, TimerEntry>();
  private queueProcessorTimer: ReturnType<typeof setInterval> | null = null;
  private alarmHandler: AlarmHandler | null = null;

  constructor(
    private readonly osBridge: SchedulerOsBridge,
    config: Partial<SchedulerAlarmConfig> = {},
  ) {
    this.config = {
      ...DEFAULT_ALARM_CONFIG,
      // Runtime has no min-delay constraint (matches the old desktop behavior).
      minScheduleDelay: 0,
      ...config,
    };
  }

  setAlarmHandler(handler: AlarmHandler): void {
    this.alarmHandler = handler;
  }

  async createJobAlarm(jobId: string, scheduledTime: number): Promise<void> {
    const alarmName = getJobAlarmName(jobId);
    this.clearTimerEntry(alarmName);

    const now = Date.now();
    const delayMs = Math.max(scheduledTime - now, 0);
    const clampedDelay = Math.min(delayMs, MAX_TIMEOUT_MS);
    const needsRecheck = delayMs > MAX_TIMEOUT_MS;

    // 1. In-process timer (precise; survives only while the runtime runs).
    const timer = setTimeout(async () => {
      if (needsRecheck && scheduledTime > Date.now()) {
        this.timers.delete(alarmName);
        try {
          await this.createJobAlarm(jobId, scheduledTime);
        } catch (error) {
          console.error(`[RuntimeSchedulerAlarms] Failed to re-arm ${alarmName}:`, error);
        }
        return;
      }
      this.timers.delete(alarmName);
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(alarmName);
        } catch (error) {
          console.error(`[RuntimeSchedulerAlarms] Error handling alarm ${alarmName}:`, error);
        }
      }
    }, clampedDelay);

    this.timers.set(alarmName, {
      timer,
      alarm: { name: alarmName, scheduledTime },
    });

    // 2. OS-level job (fires even if the runtime is fully quit). The
    // app-on-deeplink flow rehydrates the agent and replays the alarm.
    try {
      await this.osBridge.register(jobId, scheduledTime);
    } catch (error) {
      console.warn('[RuntimeSchedulerAlarms] OS register failed (in-process only):', error);
    }
  }

  async clearJobAlarm(jobId: string): Promise<void> {
    const alarmName = getJobAlarmName(jobId);
    this.clearTimerEntry(alarmName);
    try {
      await this.osBridge.remove(jobId);
    } catch (error) {
      console.warn('[RuntimeSchedulerAlarms] OS remove failed:', error);
    }
  }

  async hasJobAlarm(jobId: string): Promise<boolean> {
    return this.timers.has(getJobAlarmName(jobId));
  }

  async startJobQueueProcessor(): Promise<void> {
    if (this.queueProcessorTimer) clearInterval(this.queueProcessorTimer);
    const intervalMs = this.config.jobQueueProcessorInterval * 60_000;
    this.queueProcessorTimer = setInterval(async () => {
      if (this.alarmHandler) {
        try {
          await this.alarmHandler(SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM);
        } catch (error) {
          console.error('[RuntimeSchedulerAlarms] Queue processor error:', error);
        }
      }
    }, intervalMs);
  }

  async stopJobQueueProcessor(): Promise<void> {
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }
  }

  async getAllAlarms(): Promise<SchedulerAlarm[]> {
    const alarms: SchedulerAlarm[] = [];
    for (const entry of this.timers.values()) alarms.push(entry.alarm);
    if (this.queueProcessorTimer) {
      alarms.push({
        name: SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM,
        scheduledTime: Date.now(),
        periodInMinutes: this.config.jobQueueProcessorInterval,
      });
    }
    return alarms;
  }

  /**
   * Reconcile OS jobs with in-process timers on startup:
   *   - List OS jobs
   *   - Recreate in-process timers for jobs still in the store
   *   - Clean stale OS jobs whose source-of-truth row is gone
   */
  async reconcileOnStartup(
    getScheduledJobs: () => Promise<Array<{ id: string; scheduledTime: number | null }>>,
  ): Promise<void> {
    try {
      const osJobIds = await this.osBridge.list();
      const jobs = await getScheduledJobs();
      const jobMap = new Map(jobs.map((j) => [j.id, j]));
      for (const jobId of osJobIds) {
        const job = jobMap.get(jobId);
        if (job?.scheduledTime && job.scheduledTime > Date.now()) {
          await this.createJobAlarm(jobId, job.scheduledTime);
        } else {
          await this.osBridge.remove(jobId).catch(() => undefined);
        }
      }
    } catch (error) {
      console.warn('[RuntimeSchedulerAlarms] Could not reconcile OS jobs:', error);
    }
  }

  /** Dispose in-process timers only (OS jobs persist intentionally). */
  dispose(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
    if (this.queueProcessorTimer) {
      clearInterval(this.queueProcessorTimer);
      this.queueProcessorTimer = null;
    }
  }

  private clearTimerEntry(name: string): void {
    const entry = this.timers.get(name);
    if (entry) {
      clearTimeout(entry.timer);
      this.timers.delete(name);
    }
  }
}
