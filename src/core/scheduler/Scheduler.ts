/**
 * Scheduler
 *
 * Main orchestrator class for the Job Scheduler feature.
 * Manages job lifecycle: creation, scheduling, execution, and completion.
 *
 * Feature 015: Integrates with AgentRegistry to create isolated sessions for scheduled jobs
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  SchedulerJobRecord,
  SchedulerJobStatus,
  JobResultRecord,
} from '../models/types/Scheduler';
import type {
  ISchedulerStorage,
  ISchedulerAlarms,
  JobStatusChangedEvent,
  SchedulerStateChangedEvent,
  SchedulerJobSummary,
  GetSchedulerStateResponse,
} from '../models/types/SchedulerContracts';
import {
  parseAlarmName,
} from '../models/types/SchedulerContracts';
import type { AgentRegistry } from '../registry/AgentRegistry';

/**
 * Event emitter type for scheduler events
 */
export type SchedulerEventEmitter = (
  event: JobStatusChangedEvent | SchedulerStateChangedEvent
) => void;

/**
 * Notification handler callback — platform-specific notification display
 */
export type NotificationHandler = (job: SchedulerJobRecord) => Promise<void>;

/**
 * Job launcher callback — platform-specific job execution (open tab, invoke agent, etc.)
 */
export type JobLauncher = (jobId: string, sessionId: string) => Promise<void>;

/**
 * Connectivity check callback — returns true if the platform is online
 */
export type ConnectivityCheck = () => boolean;

/**
 * Scheduler - main orchestrator for scheduled job execution
 * Feature 015: Supports isolated AgentSession per scheduled job
 */
export class Scheduler {
  private eventEmitter: SchedulerEventEmitter | null = null;
  private registry: AgentRegistry | null = null;
  private jobSessions: Map<string, string> = new Map(); // jobId → sessionId
  private notificationHandler: NotificationHandler | null = null;
  private jobLauncher: JobLauncher | null = null;
  private connectivityCheck: ConnectivityCheck = () => true;

  constructor(
    private storage: ISchedulerStorage,
    private alarms: ISchedulerAlarms
  ) {}

  /**
   * Feature 015: Set the AgentRegistry for creating isolated sessions
   */
  setRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  /**
   * Set event emitter for status change notifications
   */
  setEventEmitter(emitter: SchedulerEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /**
   * Set notification handler for job start notifications
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Set job launcher for platform-specific job execution
   */
  setJobLauncher(launcher: JobLauncher): void {
    this.jobLauncher = launcher;
  }

  /**
   * Set connectivity check callback (defaults to () => true)
   */
  setConnectivityCheck(check: ConnectivityCheck): void {
    this.connectivityCheck = check;
  }

  /**
   * Create a draft job (no scheduled time)
   * @returns The created job ID
   */
  async createDraftJob(input: string): Promise<string> {
    const job = await this.storage.createJob(input);
    return job.id;
  }

  /**
   * Schedule a new job for future execution
   * @returns The created job ID
   */
  async scheduleJob(input: string, scheduledTime: number): Promise<string> {
    // Validate scheduled time is in the future
    const now = Date.now();
    if (scheduledTime <= now) {
      throw new Error('Scheduled time must be in the future');
    }

    // Create the job with scheduled status
    const job = await this.storage.createJob(input, scheduledTime);

    // Create alarm for the job
    await this.alarms.createJobAlarm(job.id, scheduledTime);

    return job.id;
  }

  /**
   * Schedule an existing draft job
   */
  async scheduleExistingJob(jobId: string, scheduledTime: number): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'draft') {
      throw new Error(`Cannot schedule job in ${job.status} status`);
    }

    // Validate scheduled time is in the future
    const now = Date.now();
    if (scheduledTime <= now) {
      throw new Error('Scheduled time must be in the future');
    }

    const previousStatus = job.status;

    // Update job with scheduled time and status
    await this.storage.updateJob(jobId, {
      scheduledTime,
      status: 'scheduled',
    });

    // Create alarm for the job
    await this.alarms.createJobAlarm(jobId, scheduledTime);

    // Emit status change event
    this.emitStatusChange(jobId, previousStatus, 'scheduled');
  }

  /**
   * Manually trigger a job (draft or scheduled)
   * If another job is running, adds to job queue
   */
  async triggerJob(jobId: string): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Only draft, scheduled, or missed jobs can be triggered
    if (!['draft', 'scheduled', 'missed'].includes(job.status)) {
      throw new Error(`Cannot trigger job in ${job.status} status`);
    }

    const previousStatus = job.status;

    // Clear alarm if job was scheduled
    if (job.status === 'scheduled') {
      await this.alarms.clearJobAlarm(jobId);
    }

    // Check if another job is currently running
    const state = await this.storage.getSchedulerState();
    if (state.currentJobId) {
      // Add to job queue
      await this.storage.updateJob(jobId, { status: 'waiting' });
      this.emitStatusChange(jobId, previousStatus, 'waiting');
    } else {
      // Execute immediately
      await this.executeJob(jobId);
    }
  }

  /**
   * Cancel a job
   * Feature 015: Cleans up the isolated AgentSession if job was running
   */
  async cancelJob(jobId: string): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Cannot cancel completed or failed jobs
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      throw new Error(`Cannot cancel job in ${job.status} status`);
    }

    const previousStatus = job.status;

    // Clear alarm if scheduled
    if (job.status === 'scheduled') {
      await this.alarms.clearJobAlarm(jobId);
    }

    // If job is running, need to abort execution and clean up session
    if (job.status === 'running') {
      // Feature 015: Clean up the AgentSession for this job
      await this.cleanupJobSession(jobId);
      // Clear current job from state
      await this.storage.setSchedulerState({ currentJobId: null });
      this.emitStateChange();
    }

    // Update job status
    await this.storage.updateJob(jobId, {
      status: 'cancelled',
      completedAt: Date.now(),
    });

    this.emitStatusChange(jobId, previousStatus, 'cancelled');

    // Process queue if we cancelled the running job
    if (previousStatus === 'running') {
      await this.processJobQueue();
    }
  }

  /**
   * Execute a job
   * Feature 015: Creates an isolated AgentSession for the job
   * Opens a new browser tab with the job for execution
   */
  async executeJob(jobId: string): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const previousStatus = job.status;

    // Feature 015: Create an isolated AgentSession for this scheduled job
    let sessionId: string;
    if (this.registry && this.registry.canCreateSession()) {
      try {
        const session = await this.registry.createSession({
          type: 'scheduled',
        });
        sessionId = session.sessionId;
        this.jobSessions.set(jobId, sessionId);
        console.log(`[Scheduler] Created AgentSession ${sessionId} for job ${jobId}`);
      } catch (error) {
        console.error(`[Scheduler] Failed to create AgentSession for job ${jobId}:`, error);
        // Fallback to legacy session ID
        sessionId = `session_${uuidv4()}`;
      }
    } else {
      // Legacy fallback when registry is not available
      sessionId = `session_${uuidv4()}`;
      console.log(`[Scheduler] Using legacy session ID ${sessionId} for job ${jobId}`);
    }

    // Update job to running status
    await this.storage.updateJob(jobId, {
      status: 'running',
      sessionId,
    });

    // Update scheduler state
    await this.storage.setSchedulerState({
      currentJobId: jobId,
      lastProcessedTime: Date.now(),
    });

    this.emitStatusChange(jobId, previousStatus, 'running');
    this.emitStateChange();

    // Show browser notification (T025)
    await this.showJobStartNotification(job);

    // Launch job for execution
    await this.launchJob(jobId, sessionId);
  }

  /**
   * Show notification when a scheduled job starts (delegates to platform handler)
   */
  private async showJobStartNotification(job: SchedulerJobRecord): Promise<void> {
    if (this.notificationHandler) {
      try {
        await this.notificationHandler(job);
      } catch (error) {
        console.warn('[Scheduler] Failed to show notification:', error);
      }
    }
  }

  /**
   * Launch job execution (delegates to platform handler)
   */
  private async launchJob(jobId: string, sessionId: string): Promise<void> {
    if (this.jobLauncher) {
      await this.jobLauncher(jobId, sessionId);
    } else {
      console.warn('[Scheduler] No job launcher configured — job will not execute');
    }
  }

  /**
   * Mark a job as completed
   * Called by the executing tab when job finishes successfully
   * Feature 015: Cleans up the isolated AgentSession for this job
   */
  async completeJob(
    jobId: string,
    result: JobResultRecord
  ): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'running') {
      throw new Error(`Cannot complete job in ${job.status} status`);
    }

    const previousStatus = job.status;

    // Feature 015: Clean up the AgentSession for this job
    await this.cleanupJobSession(jobId);

    // Update job with completion info
    await this.storage.updateJob(jobId, {
      status: 'completed',
      completedAt: Date.now(),
      result,
    });

    // Clear current job from state
    await this.storage.setSchedulerState({ currentJobId: null });

    this.emitStatusChange(jobId, previousStatus, 'completed');
    this.emitStateChange();

    // Process next job in queue
    await this.processJobQueue();
  }

  /**
   * Mark a job as failed
   * Called by the executing tab when job encounters an error
   * Feature 015: Cleans up the isolated AgentSession for this job
   */
  async failJob(jobId: string, error: string): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'running') {
      throw new Error(`Cannot fail job in ${job.status} status`);
    }

    const previousStatus = job.status;

    // Feature 015: Clean up the AgentSession for this job
    await this.cleanupJobSession(jobId);

    // Update job with failure info
    await this.storage.updateJob(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error,
    });

    // Clear current job from state
    await this.storage.setSchedulerState({ currentJobId: null });

    this.emitStatusChange(jobId, previousStatus, 'failed');
    this.emitStateChange();

    // Process next job in queue
    await this.processJobQueue();
  }

  /**
   * Process the job queue
   * Executes the next waiting job if no job is currently running
   */
  async processJobQueue(): Promise<void> {
    const state = await this.storage.getSchedulerState();

    // Don't process if paused
    if (state.isPaused) {
      return;
    }

    // T042: Don't process if offline
    if (!this.connectivityCheck()) {
      console.log('[Scheduler] Offline - deferring job execution until connectivity restored');
      return;
    }

    // Don't process if a job is already running
    if (state.currentJobId) {
      return;
    }

    // Get next job from queue (FIFO)
    const nextJob = await this.storage.getNextJobInQueue();
    if (nextJob) {
      await this.executeJob(nextJob.id);
    }
  }

  /**
   * T042: Check if platform is online
   */
  isOnline(): boolean {
    return this.connectivityCheck();
  }

  /**
   * Pause job queue processing
   */
  async pauseJobQueue(): Promise<void> {
    await this.storage.setSchedulerState({ isPaused: true });
    await this.alarms.stopJobQueueProcessor();
    this.emitStateChange();
  }

  /**
   * Resume job queue processing
   */
  async resumeJobQueue(): Promise<void> {
    await this.storage.setSchedulerState({ isPaused: false });
    await this.alarms.startJobQueueProcessor();
    this.emitStateChange();

    // Process queue immediately
    await this.processJobQueue();
  }

  /**
   * Handle alarm event from chrome.alarms
   */
  async handleAlarm(alarmName: string): Promise<void> {
    const event = parseAlarmName(alarmName);
    if (!event) {
      return;
    }

    if (event.type === 'job') {
      // Job alarm fired - trigger the job
      const job = await this.storage.getJob(event.jobId);
      if (job && job.status === 'scheduled') {
        await this.triggerJob(event.jobId);
      }
    } else if (event.type === 'scheduler-job-queue-processor') {
      // Queue processor alarm - process the queue
      await this.processJobQueue();
    }
  }

  /**
   * Detect and mark overdue jobs as missed
   * Called on startup
   */
  async detectMissedJobs(): Promise<SchedulerJobRecord[]> {
    const overdueJobs = await this.storage.getOverdueScheduledJobs();

    for (const job of overdueJobs) {
      const previousStatus = job.status;
      await this.storage.updateJob(job.id, { status: 'missed' });
      await this.alarms.clearJobAlarm(job.id);
      this.emitStatusChange(job.id, previousStatus, 'missed');
    }

    return overdueJobs;
  }

  /**
   * Get scheduler state for UI
   */
  async getSchedulerState(): Promise<GetSchedulerStateResponse> {
    const state = await this.storage.getSchedulerState();
    const counts = await this.storage.getJobCounts();

    let runningJob: SchedulerJobSummary | null = null;
    if (state.currentJobId) {
      const job = await this.storage.getJob(state.currentJobId);
      if (job) {
        runningJob = this.toJobSummary(job);
      }
    }

    return {
      isPaused: state.isPaused,
      currentJobId: state.currentJobId,
      draftCount: counts.draftCount,
      scheduledCount: counts.scheduledCount,
      missedCount: counts.missedCount,
      jobQueueCount: counts.waitingCount,
      runningJob,
    };
  }

  /**
   * Convert job record to summary for UI
   */
  private toJobSummary(job: SchedulerJobRecord): SchedulerJobSummary {
    return {
      id: job.id,
      input: job.input.slice(0, 100),
      scheduledTime: job.scheduledTime,
      status: job.status,
      createdAt: job.createdAt,
    };
  }

  /**
   * Emit job status change event
   */
  private emitStatusChange(
    jobId: string,
    previousStatus: SchedulerJobStatus,
    newStatus: SchedulerJobStatus
  ): void {
    if (this.eventEmitter) {
      this.eventEmitter({
        jobId,
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
        currentJobId: state.currentJobId,
      });
    }
  }

  /**
   * Feature 015: Clean up the AgentSession associated with a scheduled job
   * Called when job completes, fails, or is cancelled
   */
  private async cleanupJobSession(jobId: string): Promise<void> {
    const sessionId = this.jobSessions.get(jobId);
    if (sessionId && this.registry) {
      try {
        await this.registry.removeSession(sessionId);
        this.jobSessions.delete(jobId);
        console.log(`[Scheduler] Cleaned up AgentSession ${sessionId} for job ${jobId}`);
      } catch (error) {
        console.error(`[Scheduler] Failed to cleanup AgentSession ${sessionId} for job ${jobId}:`, error);
      }
    }
  }
}
