// File: src/core/engine/RepublicAgentEngine.ts

import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { Session } from '../Session';
import type { Event as AgentEvent } from '../protocol/events';
import type {
  RepublicAgentEngineConfig,
  EngineResult,
  RunOptions,
  ExecutionContext,
  EngineOp,
  EngineEvent,
  Submission,
  InputItem,
} from './RepublicAgentEngineConfig';

export class RepublicAgentEngine {
  readonly engineId: string;

  private config: RepublicAgentEngineConfig;
  private toolRegistry: ToolRegistry;
  private session: Session | null = null;
  private ownsSession: boolean;

  // Queue state
  private submissionQueue: Submission[] = [];
  private eventQueue: EngineEvent[] = [];
  private processingSubmission = false;
  private eventWaiters: Array<(event: EngineEvent) => void> = [];

  // Lifecycle state
  private disposed = false;
  private initialized = false;

  // Completion tracking for awaitable mode
  private completionResolvers = new Map<string, {
    resolve: (result: EngineResult) => void;
  }>();

  // Event listener callbacks (supports multiple listeners)
  private eventListeners: Array<(event: EngineEvent) => void> = [];

  constructor(config: RepublicAgentEngineConfig) {
    this.engineId = crypto.randomUUID();
    this.config = config;
    this.toolRegistry = config.toolRegistry;
    this.ownsSession = config.ownsSession ?? (config.session == null);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Use externally-provided session or create a new one
    if (this.config.session) {
      this.session = this.config.session;
      // External session: event emitter is already wired by the caller (RepublicAgent).
      // Don't re-wire it — the caller's emitter dispatches events to the UI.
    } else {
      // Sub-agent path: create a lightweight non-persistent session
      const { Session: SessionClass } = await import('../Session');
      this.session = new SessionClass(
        this.config.agentConfig,
        this.config.persistent ?? false,
        undefined,
        this.toolRegistry,
      );

      // Wire session events to the engine's event system (only for internally-owned sessions)
      this.session.setEventEmitter(async (event: AgentEvent) => {
        this.pushEvent({
          id: event.id,
          msg: event.msg as EngineEvent['msg'],
        });
      });
    }

    // Setup approval system
    this.setupApprovalSystem();

    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Interactive Mode (SQ/EQ)
  // ---------------------------------------------------------------------------

  submitOperation(op: EngineOp): string {
    this.ensureReady();
    const submission: Submission = {
      id: crypto.randomUUID(),
      op,
      timestamp: Date.now(),
    };
    this.submissionQueue.push(submission);
    this.processSubmissionQueue();
    return submission.id;
  }

  async getNextEvent(): Promise<EngineEvent> {
    if (this.eventQueue.length > 0) {
      return this.eventQueue.shift()!;
    }
    return new Promise((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  hasEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  drainEvents(): EngineEvent[] {
    const events = this.eventQueue.slice();
    this.eventQueue.length = 0;
    return events;
  }

  // ---------------------------------------------------------------------------
  // Awaitable Mode
  // ---------------------------------------------------------------------------

  async run(input: InputItem[], options?: RunOptions): Promise<EngineResult> {
    this.ensureReady();
    const submissionId = this.submitOperation({
      type: 'UserInput',
      items: input,
      context: options?.context,
    });
    return this.waitForCompletion(submissionId, options);
  }

  async runMultiple(inputs: InputItem[][], options?: RunOptions): Promise<EngineResult[]> {
    const results: EngineResult[] = [];
    for (const input of inputs) {
      const result = await this.run(input, options);
      results.push(result);
      if (!result.success && result.stopReason !== 'completed') break;
    }
    return results;
  }

  async sendFollowUp(input: InputItem[], options?: RunOptions): Promise<EngineResult> {
    this.ensureReady();
    const submissionId = this.submitOperation({
      type: 'UserTurn',
      items: input,
      context: options?.context,
    });
    return this.waitForCompletion(submissionId, options);
  }

  // ---------------------------------------------------------------------------
  // Approval
  // ---------------------------------------------------------------------------

  approveExecution(callId: string, remember?: boolean): void {
    this.submitOperation({ type: 'ExecApproval', callId, decision: 'approve', remember });
  }

  rejectExecution(callId: string): void {
    this.submitOperation({ type: 'ExecApproval', callId, decision: 'reject' });
  }

  // ---------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------

  interrupt(reason?: string): void {
    this.submitOperation({ type: 'Interrupt', reason });
  }

  cancel(): void {
    this.submissionQueue.length = 0;
    // Resolve any pending completion promises
    for (const [submissionId, resolver] of this.completionResolvers) {
      resolver.resolve({
        success: false,
        response: null,
        turnCount: 0,
        stopReason: 'cancelled',
        engineId: this.engineId,
        submissionId,
      });
    }
    this.completionResolvers.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();

    // Shutdown session if we own it
    if (this.ownsSession && this.session) {
      await this.session.shutdown();
    }

    const disposeEvent: EngineEvent = {
      id: crypto.randomUUID(),
      msg: { type: 'EngineDisposed', data: { engineId: this.engineId } },
    };
    this.eventWaiters.forEach((resolve) => resolve(disposeEvent));
    this.eventWaiters.length = 0;
    this.eventListeners.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Event Listener
  // ---------------------------------------------------------------------------

  /**
   * Register a callback that is invoked for every event pushed to the engine.
   * Supports multiple listeners. Returns an unsubscribe function.
   * Used by RepublicAgent to bridge engine events to its eventDispatcher.
   */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getSession(): Session | null {
    return this.session;
  }

  isReady(): boolean {
    return this.initialized && !this.disposed;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getConfig(): RepublicAgentEngineConfig {
    return this.config;
  }

  // ---------------------------------------------------------------------------
  // Internal: Approval System Setup
  // ---------------------------------------------------------------------------

  private setupApprovalSystem(): void {
    if (this.config.approvalGate) {
      this.toolRegistry.setApprovalGate(this.config.approvalGate);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Queue Processing
  // ---------------------------------------------------------------------------

  private async processSubmissionQueue(): Promise<void> {
    if (this.processingSubmission) return;
    this.processingSubmission = true;
    try {
      while (this.submissionQueue.length > 0) {
        const submission = this.submissionQueue.shift()!;
        try {
          await this.handleSubmission(submission);
        } catch (error) {
          console.error('[RepublicAgentEngine] Error handling submission:', error);
          this.pushEvent({
            id: crypto.randomUUID(),
            msg: {
              type: 'Error',
              data: {
                message: error instanceof Error ? error.message : String(error),
                submissionId: submission.id,
              },
            },
          });
        }
      }
    } finally {
      this.processingSubmission = false;
    }
  }

  private async handleSubmission(submission: Submission): Promise<void> {
    const { op } = submission;

    switch (op.type) {
      case 'UserInput':
      case 'UserTurn':
        await this.handleUserInput(submission.id, op.items, op.context, op.contextOverrides);
        break;
      case 'Interrupt':
        await this.handleInterrupt(op.reason);
        break;
      case 'ExecApproval':
        await this.handleExecApproval(op);
        break;
      case 'PatchApproval':
        await this.handlePatchApproval(op);
        break;
      case 'Compact':
      case 'ManualCompact':
        await this.handleCompact(op.type === 'ManualCompact' ? 'manual' : ((op as any).mode ?? 'auto'));
        break;
      case 'AddToHistory':
        await this.handleAddToHistory(op);
        break;
      case 'Shutdown':
        await this.handleShutdown();
        break;
      case 'ClearHistory':
        this.pushEvent({
          id: crypto.randomUUID(),
          msg: { type: 'HistoryCleared' },
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: UserInput — delegates to Session.spawnTask()
  // ---------------------------------------------------------------------------

  private async handleUserInput(
    submissionId: string,
    items: InputItem[],
    _context?: ExecutionContext,
    contextOverrides?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.session) {
      throw new Error('Engine session not initialized');
    }

    try {
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: { type: 'TaskStarted', data: { submissionId } },
      });

      // Add pending input to session (cast to protocol InputItem type)
      this.session.addPendingInput(items as any);

      // Apply context overrides if provided
      if (contextOverrides) {
        this.session.updateTurnContext(contextOverrides);
      }

      const turnContext = this.session.getTurnContext();
      if (!turnContext) {
        throw new Error('Turn context not initialized');
      }

      // Create RegularTask and delegate to Session.spawnTask()
      const { RegularTask } = await import('../tasks/RegularTask');
      const task = new RegularTask();

      await this.session.spawnTask(task, turnContext, submissionId, items as any);

      // Session.spawnTask() is fire-and-forget.
      // Task completion/abort events are emitted by Session via the event emitter
      // we wired in initialize().
    } catch (error) {
      console.error('[RepublicAgentEngine] Error processing user input:', error);

      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'TaskError',
          data: {
            submissionId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: Interrupt — abort all tasks
  // ---------------------------------------------------------------------------

  private async handleInterrupt(reason?: string): Promise<void> {
    if (!this.session) return;

    // Set interrupt flag
    this.session.requestInterrupt();

    // Clear pending submissions
    this.submissionQueue.length = 0;

    // Emit abort event
    this.pushEvent({
      id: crypto.randomUUID(),
      msg: {
        type: 'TurnAborted',
        data: { reason: reason ?? 'user_interrupt' },
      },
    });

    // Delegate to Session.abortAllTasks()
    await this.session.abortAllTasks('UserInterrupt');

    // Clear interrupt flag
    this.session.clearInterrupt();
  }

  // ---------------------------------------------------------------------------
  // Handler: ExecApproval — dual routing (ApprovalManager + Session)
  // ---------------------------------------------------------------------------

  private async handleExecApproval(op: Extract<EngineOp, { type: 'ExecApproval' }>): Promise<void> {
    if (!this.session) return;

    const { callId, decision, remember, alternativeText } = op;

    // Capture pending approval data before handleDecision removes it
    let toolName = '';
    let params: Record<string, any> = {};
    let domain: string | undefined;
    let riskScore: number | undefined;

    const approvalManager = this.config.approvalManager;
    if (remember && approvalManager) {
      const pending = approvalManager.getApproval(callId);
      if (pending) {
        toolName = pending.request?.metadata?.toolName || '';
        params = pending.request?.details?.parameters || {};
        domain = pending.request?.metadata?.domain;
        riskScore = pending.request?.metadata?.riskScore;
      } else {
        console.warn(`[RepublicAgentEngine] Cannot remember decision - no pending approval for id: ${callId}`);
      }
    }

    // Dual routing: ApprovalManager (risk-based) + Session (protocol-level)
    let riskBasedResolved = false;
    if (approvalManager) {
      try {
        await approvalManager.handleDecision({
          id: callId,
          decision,
          timestamp: Date.now(),
          reason: alternativeText || (decision === 'reject' ? 'Denied by user' : undefined),
        });
        riskBasedResolved = true;
      } catch (error) {
        console.warn(`[RepublicAgentEngine] ApprovalManager.handleDecision failed for ${callId}:`, error);
      }
    }

    let protocolResolved = false;
    try {
      this.session.notifyApproval(callId, decision);
      protocolResolved = true;
    } catch (error) {
      console.warn(`[RepublicAgentEngine] Session.notifyApproval failed for ${callId}:`, error);
    }

    if (!riskBasedResolved && !protocolResolved) {
      console.error(`[RepublicAgentEngine] Approval decision could not be routed for id: ${callId} — no pending request found in either subsystem`);
    }

    // Remember decision if requested
    if (remember && toolName) {
      const approvalGate = this.toolRegistry.getApprovalGate();
      if (approvalGate) {
        approvalGate.rememberDecision(
          toolName,
          params,
          decision === 'approve' ? 'auto_approve' : 'deny',
          domain,
          riskScore,
        );
      }
    }

    this.pushEvent({
      id: crypto.randomUUID(),
      msg: {
        type: 'BackgroundEvent',
        data: {
          message: `Execution ${decision}: ${callId}`,
          level: 'info',
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Handler: PatchApproval — protocol-level only
  // ---------------------------------------------------------------------------

  private async handlePatchApproval(op: Extract<EngineOp, { type: 'PatchApproval' }>): Promise<void> {
    if (!this.session) return;

    this.session.notifyApproval(op.patchId, op.decision);

    this.pushEvent({
      id: crypto.randomUUID(),
      msg: {
        type: 'BackgroundEvent',
        data: {
          message: `Patch ${op.decision}: ${op.patchId}`,
          level: 'info',
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Handler: Compact — delegate to Session.compact()
  // ---------------------------------------------------------------------------

  private async handleCompact(mode: 'auto' | 'manual'): Promise<void> {
    if (!this.session) return;

    try {
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'BackgroundEvent',
          data: {
            message: `History compaction started (${mode})`,
            level: 'info',
          },
        },
      });

      const historyBefore = this.session.getConversationHistory().items.length;

      // Get model client for LLM-based summarization
      const modelClient = await this.config.modelClientFactory.createClientForCurrentModel();
      const result = await this.session.compact(mode, modelClient);

      const historyAfter = this.session.getConversationHistory().items.length;

      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'CompactionCompleted',
          data: {
            success: result.success,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            itemsTrimmed: result.itemsTrimmed,
            compactionCount: this.session.getCompactionCount(),
            triggerReason: mode,
            error: result.error,
          },
        },
      });

      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'BackgroundEvent',
          data: {
            message: `History compaction completed: ${historyBefore} → ${historyAfter} items (saved ~${result.tokensBefore - result.tokensAfter} tokens)`,
            level: 'info',
          },
        },
      });
    } catch (error) {
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'Error',
          data: {
            message: `History compaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        },
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: AddToHistory
  // ---------------------------------------------------------------------------

  private async handleAddToHistory(op: Extract<EngineOp, { type: 'AddToHistory' }>): Promise<void> {
    if (!this.session) return;

    this.session.addToHistory({
      timestamp: Date.now(),
      text: op.text,
      type: 'user',
    });
  }

  // ---------------------------------------------------------------------------
  // Handler: Shutdown
  // ---------------------------------------------------------------------------

  private async handleShutdown(): Promise<void> {
    this.submissionQueue.length = 0;
    this.eventQueue.length = 0;

    this.pushEvent({
      id: crypto.randomUUID(),
      msg: { type: 'ShutdownComplete' },
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: Event Handling
  // ---------------------------------------------------------------------------

  pushEvent(event: EngineEvent): void {
    // Notify all listeners (used by RepublicAgent event bridge)
    for (const listener of this.eventListeners) {
      listener(event);
    }

    if (this.config.eventRouter) {
      this.config.eventRouter.routeEvent(event, {
        engineId: this.engineId,
        parentEngineId: this.config.parentEngineId,
      });
      return;
    }

    this.eventQueue.push(event);

    if (this.eventWaiters.length > 0) {
      const waiter = this.eventWaiters.shift()!;
      const queuedEvent = this.eventQueue.shift()!;
      waiter(queuedEvent);
    }
  }

  private async waitForCompletion(
    submissionId: string,
    options?: RunOptions,
  ): Promise<EngineResult> {
    const abortController = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // Default 10 minutes

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        abortController.abort();
        this.interrupt('Cancelled');
      });
    }

    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.interrupt('Timeout');
        return {
          success: false,
          response: null,
          turnCount: 0,
          stopReason: 'error',
          error: `Timed out after ${timeoutMs}ms`,
          engineId: this.engineId,
          submissionId,
        };
      }

      const event = await Promise.race([
        this.getNextEvent(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);

      if (event === null) {
        this.interrupt('Timeout');
        return {
          success: false,
          response: null,
          turnCount: 0,
          stopReason: 'error',
          error: `Timed out after ${timeoutMs}ms`,
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'TaskComplete' && event.msg.data?.submissionId === submissionId) {
        return {
          success: true,
          response: (event.msg.data.response as string | null) ?? null,
          turnCount: (event.msg.data.turnCount as number) ?? 0,
          tokenUsage: event.msg.data.tokenUsage as EngineResult['tokenUsage'],
          stopReason: 'completed',
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'TaskError' && event.msg.data?.submissionId === submissionId) {
        return {
          success: false,
          response: null,
          turnCount: 0,
          tokenUsage: undefined,
          stopReason: 'error',
          error: event.msg.data.error as string,
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'TaskAborted') {
        return {
          success: false,
          response: null,
          turnCount: 0,
          tokenUsage: undefined,
          stopReason: abortController.signal.aborted ? 'cancelled' : 'interrupted',
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'EngineDisposed') {
        return {
          success: false,
          response: null,
          turnCount: 0,
          stopReason: 'cancelled',
          error: 'Engine disposed',
          engineId: this.engineId,
          submissionId,
        };
      }
    }
  }

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('RepublicAgentEngine.initialize() must be called first');
    }
    if (this.disposed) {
      throw new Error('RepublicAgentEngine has been disposed');
    }
  }
}
