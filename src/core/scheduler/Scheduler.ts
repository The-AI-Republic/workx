/**
 * Scheduler (Facade)
 *
 * Delegates to ScheduleManager (when to run) and JobExecutor (how to run).
 * All legacy SchedulerStorage / SchedulerJobRecord dependencies have been removed.
 * The single source of truth is now ScheduleEvent + ExecutionRecord.
 */

import type {
  JobResultRecord,
  RecurrenceRule,
} from '../models/types/Scheduler';
import type {
  ISchedulerAlarms,
  SchedulerJobSummary,
  ArchivedJobSummary,
  GetSchedulerStateResponse,
  SchedulerStateChangedEvent,
} from '../models/types/SchedulerContracts';
import {
  parseAlarmName,
} from '../models/types/SchedulerContracts';
import type { ScheduleEvent } from '../models/types/ScheduleEvent';
import type { ExecutionRecord, ExecutionStatus } from '../models/types/ScheduleEvent';
import type { AgentRegistry } from '../registry/AgentRegistry';
import type { ScheduleManager } from './ScheduleManager';
import type { JobExecutor, ExecutionNotificationHandler, ExecutionJobLauncher, ExecutionConnectivityCheck, ExecutionEventEmitter } from './JobExecutor';
import { recurrenceRuleToRRule } from './rruleAdapter';

/**
 * Event emitter type for scheduler events
 */
export type SchedulerEventEmitter = (
  event: Record<string, unknown>
) => void;

/**
 * Notification handler callback — platform-specific notification display
 */
export type NotificationHandler = (info: { input: string }) => Promise<void>;

/**
 * Job launcher callback — platform-specific job execution
 */
export type JobLauncher = (
  executionId: string,
  sessionId: string,
  agent: import('../RepublicAgent').RepublicAgent | null
) => Promise<void>;

/**
 * Connectivity check callback
 */
export type ConnectivityCheck = () => boolean;

/**
 * Scheduler — facade that delegates to ScheduleManager + JobExecutor.
 */
export class Scheduler {
  private eventEmitter: SchedulerEventEmitter | null = null;

  constructor(
    private scheduleManager: ScheduleManager,
    private jobExecutor: JobExecutor,
    private alarms: ISchedulerAlarms,
  ) {
    // Wire ScheduleManager alarm → JobExecutor execution
    this.scheduleManager.setAlarmFiredHandler(async (eventId, instanceTime, input) => {
      await this.jobExecutor.execute(eventId, instanceTime, input);
    });

    // Wire JobExecutor completion → ScheduleManager alarm re-arming
    this.jobExecutor.setExecutionCompleteHandler(async (eventId) => {
      await this.scheduleManager.armNextAlarm(eventId);
    });
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  getScheduleManager(): ScheduleManager {
    return this.scheduleManager;
  }

  getJobExecutor(): JobExecutor {
    return this.jobExecutor;
  }

  // ==========================================================================
  // Configuration setters (pass through to delegates)
  // ==========================================================================

  setRegistry(registry: AgentRegistry): void {
    this.jobExecutor.setRegistry(registry);
  }

  setEventEmitter(emitter: SchedulerEventEmitter): void {
    this.eventEmitter = emitter;
    // Also wire to JobExecutor for execution status events
    this.jobExecutor.setEventEmitter((event) => {
      if (this.eventEmitter) {
        this.eventEmitter(event);
      }
    });
  }

  /**
   * Connect scheduler events to a ChannelManager channel.
   * This is the unified way to wire scheduler event dispatch — all platforms
   * should use this instead of calling setEventEmitter() with custom logic.
   *
   * Events are dispatched as BackgroundEvent with message 'scheduler_job_status',
   * matching the format the UI listens for.
   *
   * @param getChannelManager - returns the ChannelManager (called per-event for lazy resolution)
   * @param channelId - target channel ID
   */
  connectToChannel(
    getChannelManager: () => { dispatchEvent(event: any, channelId: string): Promise<void> },
    channelId: string
  ): void {
    this.setEventEmitter((event) => {
      try {
        getChannelManager().dispatchEvent(
          { type: 'BackgroundEvent', data: { message: 'scheduler_job_status', level: 'info', schedulerEvent: event } },
          channelId
        ).catch((error) => {
          console.error('[Scheduler] Failed to dispatch event:', error);
        });
      } catch {
        // ChannelManager not available yet — silently ignore
      }
    });
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.jobExecutor.setNotificationHandler(async (_eventId, _instanceTime, input) => {
      await handler({ input });
    });
  }

  setJobLauncher(launcher: JobLauncher): void {
    this.jobExecutor.setJobLauncher(async (executionId, sessionId, agent) => {
      await launcher(executionId, sessionId, agent);
    });
  }

  setConnectivityCheck(check: ConnectivityCheck): void {
    this.jobExecutor.setConnectivityCheck(check);
  }

  // ==========================================================================
  // Job Lifecycle
  // ==========================================================================

  /**
   * Schedule a new job for future execution.
   * Creates a ScheduleEvent. Recurrence is handled via RRULE.
   */
  async scheduleJob(input: string, scheduledTime: number, recurrence?: RecurrenceRule): Promise<string> {
    let rruleString: string | null = null;
    if (recurrence) {
      rruleString = recurrenceRuleToRRule(recurrence, scheduledTime);
    }

    const event = await this.scheduleManager.createEvent(input, scheduledTime, rruleString);
    return event.id;
  }

  /**
   * Manually trigger an event (execute immediately).
   */
  async triggerJob(eventId: string): Promise<void> {
    const event = await this.scheduleManager.getEvent(eventId);
    if (!event) {
      throw new Error(`Schedule event not found: ${eventId}`);
    }

    // Execute immediately with current time as instance time
    await this.jobExecutor.execute(eventId, Date.now(), event.input);
  }

  /**
   * Cancel a running execution or disable a schedule event.
   */
  async cancelJob(id: string): Promise<void> {
    // Try as execution ID first (cancel running execution)
    try {
      const execution = await this.jobExecutor.getExecutionHistory(id)
        .then(() => null)
        .catch(() => null);
      // Direct execution lookup — attempt to cancel
      await this.jobExecutor.cancelExecution(id);
      return;
    } catch {
      // Not an execution — try as schedule event
    }

    // Try as schedule event ID (disable the event)
    const event = await this.scheduleManager.getEvent(id);
    if (event) {
      await this.scheduleManager.setEnabled(id, false);
      await this.alarms.clearJobAlarm(id);
      return;
    }

    throw new Error(`Not found: ${id}`);
  }

  /**
   * Mark an execution as completed.
   */
  async completeJob(executionId: string, result: JobResultRecord): Promise<void> {
    await this.jobExecutor.completeExecution(executionId, result);
  }

  /**
   * Mark an execution as failed.
   */
  async failJob(executionId: string, error: string): Promise<void> {
    await this.jobExecutor.failExecution(executionId, error);
  }

  /**
   * Reschedule an event to a new time.
   */
  async rescheduleJob(eventId: string, newScheduledTime: number): Promise<void> {
    await this.scheduleManager.editSeries(eventId, { scheduledTime: newScheduledTime });
  }

  // ==========================================================================
  // Alarm Handling
  // ==========================================================================

  /**
   * Handle alarm event. Always routes to ScheduleManager (no legacy branch).
   */
  async handleAlarm(alarmName: string): Promise<void> {
    const event = parseAlarmName(alarmName);
    if (!event) return;

    if (event.type === 'job') {
      await this.scheduleManager.handleAlarmFired(event.jobId);
    } else if (event.type === 'scheduler-job-queue-processor') {
      await this.jobExecutor.processQueue();
    }
  }

  // ==========================================================================
  // Queue Control
  // ==========================================================================

  async processJobQueue(): Promise<void> {
    await this.jobExecutor.processQueue();
  }

  async pauseJobQueue(): Promise<void> {
    this.jobExecutor.pauseQueue();
    await this.alarms.stopJobQueueProcessor();
    this.emitStateChange({ isPaused: true, currentJobId: null });
  }

  async resumeJobQueue(): Promise<void> {
    this.jobExecutor.resumeQueue();
    await this.alarms.startJobQueueProcessor();
    this.emitStateChange({ isPaused: false, currentJobId: null });
    await this.jobExecutor.processQueue();
  }

  isOnline(): boolean {
    return this.jobExecutor.isOnline();
  }

  // ==========================================================================
  // Startup / Recovery
  // ==========================================================================

  async recoverStaleRunningJob(): Promise<void> {
    await this.jobExecutor.recoverStaleExecutions();
  }

  /**
   * Detect missed instances on startup.
   * Returns missed instances for logging/notification.
   */
  async detectMissedJobs(): Promise<Array<{ event: ScheduleEvent; instanceTime: number }>> {
    return this.scheduleManager.getMissedInstances();
  }

  async restoreScheduleAlarms(): Promise<void> {
    await this.scheduleManager.restoreAlarms();
  }

  // ==========================================================================
  // State Queries (for UI)
  // ==========================================================================

  /**
   * Get scheduler state for UI.
   * Builds state from new model queries.
   */
  async getSchedulerState(): Promise<GetSchedulerStateResponse> {
    const isPaused = this.jobExecutor.getPauseState();
    const scheduled = await this.scheduleManager.getScheduledEvents();
    const missed = await this.scheduleManager.getMissedInstances();
    const pending = await this.jobExecutor['executionStorage'].getExecutionsByStatus('pending');
    const running = await this.jobExecutor['executionStorage'].getRunningExecutions();

    let runningJob: SchedulerJobSummary | null = null;
    let currentJobId: string | null = null;
    if (running.length > 0) {
      const exec = running[0];
      currentJobId = exec.id;
      runningJob = {
        id: exec.id,
        input: exec.input.slice(0, 100),
        scheduledTime: exec.instanceTime,
        status: 'running',
        createdAt: exec.instanceTime,
      };
    }

    return {
      isPaused,
      currentJobId,
      draftCount: 0,
      scheduledCount: scheduled.length,
      missedCount: missed.length,
      jobQueueCount: pending.length,
      runningJob,
    };
  }

  /**
   * Get scheduled events (replaces getScheduledJobs for message handlers).
   */
  async getScheduledJobs(): Promise<SchedulerJobSummary[]> {
    const events = await this.scheduleManager.getScheduledEvents();
    return events.map(e => this.eventToJobSummary(e));
  }

  /**
   * Get missed instances as job summaries.
   */
  async getMissedJobs(): Promise<SchedulerJobSummary[]> {
    const missed = await this.scheduleManager.getMissedInstances();
    return missed.map(m => ({
      id: m.event.id,
      input: m.event.input.slice(0, 100),
      scheduledTime: m.instanceTime,
      status: 'missed' as const,
      createdAt: m.event.createdAt,
    }));
  }

  /**
   * Get job queue (pending executions).
   */
  async getJobQueue(): Promise<SchedulerJobSummary[]> {
    const pending = await this.jobExecutor['executionStorage'].getExecutionsByStatus('pending');
    return pending.map(e => this.executionToJobSummary(e, 'waiting'));
  }

  /**
   * Get archived executions with pagination.
   */
  async getArchivedJobs(
    limit: number,
    offset: number,
    sortDirection?: 'newest' | 'oldest',
    statusFilter?: string[]
  ): Promise<{ jobs: ArchivedJobSummary[]; total: number; hasMore: boolean }> {
    const execStatusFilter = statusFilter as ExecutionStatus[] | undefined;
    const [executions, total] = await Promise.all([
      this.jobExecutor['executionStorage'].getArchivedExecutions(limit, offset, sortDirection, execStatusFilter),
      this.jobExecutor['executionStorage'].getArchivedExecutionsCount(execStatusFilter),
    ]);
    const jobs: ArchivedJobSummary[] = executions.map(e => ({
      id: e.id,
      input: e.input.slice(0, 100),
      scheduledTime: e.instanceTime,
      completedAt: e.completedAt ?? 0,
      status: e.status as 'completed' | 'failed' | 'cancelled',
      sessionId: e.sessionId,
      error: e.error ?? undefined,
    }));
    return { jobs, total, hasMore: offset + jobs.length < total };
  }

  /**
   * Get job details by event ID or execution ID.
   */
  async getJobDetails(jobId: string): Promise<unknown> {
    // Try as schedule event
    const event = await this.scheduleManager.getEvent(jobId);
    if (event) {
      return {
        id: event.id,
        input: event.input,
        scheduledTime: event.scheduledTime,
        createdAt: event.createdAt,
        status: event.enabled ? 'scheduled' : 'cancelled',
        sessionId: null,
        completedAt: null,
        error: null,
      };
    }

    // Try as execution
    const execution = await this.jobExecutor['executionStorage'].getExecution(jobId);
    if (execution) {
      return {
        id: execution.id,
        input: execution.input,
        scheduledTime: execution.instanceTime,
        createdAt: execution.instanceTime,
        status: execution.status,
        sessionId: execution.sessionId,
        completedAt: execution.completedAt,
        error: execution.error,
      };
    }

    return null;
  }

  /**
   * Get all events in a date range (for calendar).
   */
  async getAllJobsInRange(startTime: number, endTime: number): Promise<SchedulerJobSummary[]> {
    const instances = await this.scheduleManager.getInstancesInRange(startTime, endTime);
    return instances.map(i => ({
      id: i.scheduleEventId,
      input: i.input.slice(0, 100),
      scheduledTime: i.instanceTime,
      status: i.status as string,
      createdAt: i.instanceTime,
    }));
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  private eventToJobSummary(event: ScheduleEvent): SchedulerJobSummary {
    return {
      id: event.id,
      input: event.input.slice(0, 100),
      scheduledTime: event.scheduledTime,
      status: 'scheduled',
      createdAt: event.createdAt,
    };
  }

  private executionToJobSummary(exec: ExecutionRecord, statusOverride?: string): SchedulerJobSummary {
    return {
      id: exec.id,
      input: exec.input.slice(0, 100),
      scheduledTime: exec.instanceTime,
      status: (statusOverride || exec.status) as string,
      createdAt: exec.instanceTime,
    };
  }

  private emitStateChange(state: SchedulerStateChangedEvent): void {
    if (this.eventEmitter) {
      this.eventEmitter({ ...state });
    }
  }
}
