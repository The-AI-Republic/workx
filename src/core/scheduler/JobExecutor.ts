/**
 * JobExecutor
 *
 * Handles job execution: creating execution records, agent sessions,
 * launching jobs, completing/failing executions, queue management.
 *
 * This handles "how to run" — separated from "when to run" (ScheduleManager).
 */

import { v4 as uuidv4 } from 'uuid';
import type { IExecutionStorage } from '../models/types/ScheduleContracts';
import type {
  ExecutionRecord,
} from '../models/types/ScheduleEvent';
import { createExecutionRecord } from '../models/types/ScheduleEvent';
import type { JobResultRecord } from '../models/types/Scheduler';
import type { AgentRegistry } from '../registry/AgentRegistry';

/**
 * Notification handler callback — platform-specific notification display
 */
export type ExecutionNotificationHandler = (
  scheduleEventId: string,
  instanceTime: number,
  input: string
) => Promise<void>;

/**
 * Job launcher callback — platform-specific job execution
 */
export type ExecutionJobLauncher = (
  executionId: string,
  sessionId: string,
  agent: import('../RepublicAgent').RepublicAgent | null
) => Promise<void>;

/**
 * Connectivity check callback
 */
export type ExecutionConnectivityCheck = () => boolean;

/**
 * Callback to notify ScheduleManager that execution completed (for re-arming alarms).
 */
export type ExecutionCompleteHandler = (scheduleEventId: string) => Promise<void>;

/**
 * Event emitter for execution status changes
 */
/**
 * Machine-readable cause for a scheduled-execution failure/degradation.
 * Closed enum (privacy-clean) so telemetry can answer "why did a scheduled
 * job abort" — including the pre-session cases the scheduler was previously
 * silent about. `concurrent`/`offline`/`missed` have no execution record at
 * the point they occur and remain documented residue (not emitted yet).
 */
export type ExecutionFailureReason =
  | 'session_create_failed'
  | 'no_launcher'
  | 'launcher_error'
  | 'agent_error'
  | 'stale_recovered'
  | 'mutex_queued'
  | 'offline'
  | 'missed'
  | 'concurrent';

export type ExecutionEventEmitter = (event: {
  executionId: string;
  scheduleEventId: string;
  status: string;
  timestamp: number;
  failureReason?: ExecutionFailureReason;
}) => void;

export class JobExecutor {
  private registry: AgentRegistry | null = null;
  private executionSessions: Map<string, string> = new Map(); // executionId → registrySessionId
  private notificationHandler: ExecutionNotificationHandler | null = null;
  private jobLauncher: ExecutionJobLauncher | null = null;
  private connectivityCheck: ExecutionConnectivityCheck = () => true;
  private executionCompleteHandler: ExecutionCompleteHandler | null = null;
  private eventEmitter: ExecutionEventEmitter | null = null;
  private isPaused = false;
  private isExecuting = false; // mutex to prevent concurrent execution
  private executingIds: Set<string> = new Set(); // guard against concurrent triggers

  constructor(
    private executionStorage: IExecutionStorage,
  ) {}

  // ==========================================================================
  // Configuration setters
  // ==========================================================================

  setRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  setNotificationHandler(handler: ExecutionNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setJobLauncher(launcher: ExecutionJobLauncher): void {
    this.jobLauncher = launcher;
  }

  setConnectivityCheck(check: ExecutionConnectivityCheck): void {
    this.connectivityCheck = check;
  }

  setExecutionCompleteHandler(handler: ExecutionCompleteHandler): void {
    this.executionCompleteHandler = handler;
  }

  setEventEmitter(emitter: ExecutionEventEmitter): void {
    this.eventEmitter = emitter;
  }

  isOnline(): boolean {
    return this.connectivityCheck();
  }

  // ==========================================================================
  // Execute
  // ==========================================================================

  /**
   * Execute a schedule event instance.
   * Creates an ExecutionRecord, agent session, and launches the job.
   */
  async execute(
    scheduleEventId: string,
    instanceTime: number,
    input: string
  ): Promise<string> {
    // Guard against concurrent triggers of the same instance
    const key = `${scheduleEventId}:${instanceTime}`;
    if (this.executingIds.has(key)) {
      throw new Error('Execution already in progress for this instance');
    }
    this.executingIds.add(key);

    try {
      // Mutex: prevent concurrent execution starts
      if (this.isExecuting) {
        // Queue as a pending execution (input preserved for later execution)
        const id = uuidv4();
        const record = createExecutionRecord(id, scheduleEventId, instanceTime, input);
        await this.executionStorage.createExecution(record);
        // Telemetry: a deferral was previously silent (status 'pending' is
        // never emitted). Surface it so operators see queue back-pressure.
        this.emitEvent(id, scheduleEventId, 'pending', 'mutex_queued');
        return id;
      }
      this.isExecuting = true;

      try {
        // Create execution record
        const executionId = uuidv4();
        const record = createExecutionRecord(executionId, scheduleEventId, instanceTime, input);
        record.status = 'running';
        record.startedAt = Date.now();

        // Create agent session
        let sessionId: string;
        let sessionCreateFailed = false;
        if (this.registry && this.registry.canCreateSession()) {
          try {
            const session = await this.registry.createSession({ type: 'scheduled' });
            sessionId = session.sessionId;
            this.executionSessions.set(executionId, sessionId);
          } catch (error) {
            console.error(`[JobExecutor] Failed to create session for execution ${executionId}:`, error);
            sessionId = `session_${uuidv4()}`;
            sessionCreateFailed = true;
          }
        } else {
          sessionId = `session_${uuidv4()}`;
        }

        record.sessionId = sessionId;
        await this.executionStorage.createExecution(record);

        // Show notification
        await this.showNotification(scheduleEventId, instanceTime, input);

        // Emit running event before launch (launchJob catches errors and calls failExecution,
        // which would emit 'failed' — so we must emit 'running' first).
        // A swallowed session-create failure was previously invisible; tag it.
        this.emitEvent(
          executionId,
          scheduleEventId,
          'running',
          sessionCreateFailed ? 'session_create_failed' : undefined,
        );

        // Launch job
        await this.launchJob(executionId, sessionId);

        return executionId;
      } finally {
        this.isExecuting = false;
      }
    } finally {
      this.executingIds.delete(key);
    }
  }

  /**
   * Mark an execution as completed.
   */
  async completeExecution(executionId: string, result: JobResultRecord): Promise<void> {
    const execution = await this.executionStorage.getExecution(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);
    if (execution.status !== 'running') {
      throw new Error(`Cannot complete execution in ${execution.status} status`);
    }

    await this.cleanupSession(executionId);

    await this.executionStorage.updateExecution(executionId, {
      status: 'completed',
      result,
      completedAt: Date.now(),
    });

    this.emitEvent(executionId, execution.scheduleEventId, 'completed');

    // Notify ScheduleManager to re-arm alarms
    if (this.executionCompleteHandler) {
      await this.executionCompleteHandler(execution.scheduleEventId);
    }

    // Process queue
    await this.processQueue();
  }

  /**
   * Mark an execution as failed.
   */
  async failExecution(
    executionId: string,
    error: string,
    failureReason: ExecutionFailureReason = 'agent_error',
  ): Promise<void> {
    const execution = await this.executionStorage.getExecution(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);
    if (execution.status !== 'running') {
      throw new Error(`Cannot fail execution in ${execution.status} status`);
    }

    await this.cleanupSession(executionId);

    await this.executionStorage.updateExecution(executionId, {
      status: 'failed',
      error,
      completedAt: Date.now(),
    });

    this.emitEvent(executionId, execution.scheduleEventId, 'failed', failureReason);

    // Notify ScheduleManager to re-arm alarms (failed jobs don't break the chain)
    if (this.executionCompleteHandler) {
      await this.executionCompleteHandler(execution.scheduleEventId);
    }

    // Schedule queue processing asynchronously to avoid recursion
    // (failExecution can be called from launchJob → executePendingRecord → processQueue)
    queueMicrotask(() => { this.processQueue().catch(() => {}); });
  }

  /**
   * Cancel an execution.
   */
  async cancelExecution(executionId: string): Promise<void> {
    const execution = await this.executionStorage.getExecution(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);
    if (execution.status !== 'running' && execution.status !== 'pending') {
      throw new Error(`Cannot cancel execution in ${execution.status} status`);
    }

    await this.cleanupSession(executionId);

    await this.executionStorage.updateExecution(executionId, {
      status: 'cancelled',
      completedAt: Date.now(),
    });

    this.emitEvent(executionId, execution.scheduleEventId, 'cancelled');

    // Process queue
    if (execution.status === 'running') {
      await this.processQueue();
    }
  }

  // ==========================================================================
  // Pause / Resume
  // ==========================================================================

  pauseQueue(): void {
    this.isPaused = true;
  }

  resumeQueue(): void {
    this.isPaused = false;
  }

  getPauseState(): boolean {
    return this.isPaused;
  }

  // ==========================================================================
  // Queue Management
  // ==========================================================================

  /**
   * Process pending executions (FIFO).
   */
  async processQueue(): Promise<void> {
    if (this.isPaused) return;
    if (this.isExecuting) return;
    if (!this.connectivityCheck()) return;

    const pending = await this.executionStorage.getExecutionsByStatus('pending');
    if (pending.length === 0) return;

    // FIFO: process the oldest first
    const sorted = pending.sort((a, b) => a.instanceTime - b.instanceTime);
    const next = sorted[0];

    // Re-execute the pending record
    await this.executePendingRecord(next);
  }

  /**
   * Execute a pending execution record (previously queued).
   */
  private async executePendingRecord(record: ExecutionRecord): Promise<void> {
    if (this.isExecuting) return;
    this.isExecuting = true;

    try {
      // Create agent session
      let sessionId: string;
      let sessionCreateFailed = false;
      if (this.registry && this.registry.canCreateSession()) {
        try {
          const session = await this.registry.createSession({ type: 'scheduled' });
          sessionId = session.sessionId;
          this.executionSessions.set(record.id, sessionId);
        } catch {
          sessionId = `session_${uuidv4()}`;
          sessionCreateFailed = true;
        }
      } else {
        sessionId = `session_${uuidv4()}`;
      }

      await this.executionStorage.updateExecution(record.id, {
        status: 'running',
        sessionId,
        startedAt: Date.now(),
      });

      this.emitEvent(
        record.id,
        record.scheduleEventId,
        'running',
        sessionCreateFailed ? 'session_create_failed' : undefined,
      );

      // Show notification with the stored input
      await this.showNotification(record.scheduleEventId, record.instanceTime, record.input);

      await this.launchJob(record.id, sessionId);
    } finally {
      this.isExecuting = false;
    }
  }

  // ==========================================================================
  // Recovery
  // ==========================================================================

  /**
   * Recover stale running executions on startup.
   * Marks them as failed so the queue can proceed.
   */
  async recoverStaleExecutions(): Promise<void> {
    const running = await this.executionStorage.getRunningExecutions();
    for (const execution of running) {
      console.log(`[JobExecutor] Recovering stale execution ${execution.id} — marking as failed`);
      await this.executionStorage.updateExecution(execution.id, {
        status: 'failed',
        error: 'Execution interrupted: app was restarted while job was running',
        completedAt: Date.now(),
      });
      this.emitEvent(
        execution.id,
        execution.scheduleEventId,
        'failed',
        'stale_recovered',
      );
    }
  }

  /**
   * Get execution history for a schedule event.
   */
  async getExecutionHistory(scheduleEventId: string): Promise<ExecutionRecord[]> {
    return this.executionStorage.getExecutionsByEvent(scheduleEventId);
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async showNotification(
    scheduleEventId: string,
    instanceTime: number,
    input: string
  ): Promise<void> {
    if (this.notificationHandler) {
      try {
        await this.notificationHandler(scheduleEventId, instanceTime, input);
      } catch (error) {
        console.warn('[JobExecutor] Failed to show notification:', error);
      }
    }
  }

  private async launchJob(executionId: string, sessionId: string): Promise<void> {
    try {
      if (this.jobLauncher) {
        let agent = null;
        const registrySessionId = this.executionSessions.get(executionId);
        if (registrySessionId && this.registry) {
          const session = this.registry.getSession(registrySessionId);
          agent = session?.agent ?? null;
        }
        await this.jobLauncher(executionId, sessionId, agent);
      } else {
        // No launcher: behavior intentionally unchanged (no state change) to
        // avoid a scheduler control-flow regression. This is documented
        // residue alongside concurrent/offline/missed — the `no_launcher`
        // enum value is reserved but not emitted here (design §6 "residue").
        console.warn('[JobExecutor] No job launcher configured — execution will not run');
      }
    } catch (error) {
      console.error(`[JobExecutor] Job launcher failed for execution ${executionId}:`, error);
      await this.failExecution(executionId, `Job launcher error: ${error instanceof Error ? error.message : String(error)}`, 'launcher_error');
    }
  }

  private async cleanupSession(executionId: string): Promise<void> {
    const sessionId = this.executionSessions.get(executionId);
    if (sessionId && this.registry) {
      try {
        await this.registry.removeSession(sessionId);
      } catch (error) {
        console.error(`[JobExecutor] Failed to cleanup session for execution ${executionId}:`, error);
      } finally {
        this.executionSessions.delete(executionId);
      }
    }
  }

  private emitEvent(
    executionId: string,
    scheduleEventId: string,
    status: string,
    failureReason?: ExecutionFailureReason,
  ): void {
    if (this.eventEmitter) {
      this.eventEmitter({
        executionId,
        scheduleEventId,
        status,
        timestamp: Date.now(),
        ...(failureReason ? { failureReason } : {}),
      });
    }
  }
}
