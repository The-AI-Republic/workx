// File: src/core/engine/RepublicAgentEngine.ts

import type { ToolRegistry } from '../../tools/ToolRegistry';
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

  constructor(config: RepublicAgentEngineConfig) {
    this.engineId = crypto.randomUUID();
    this.config = config;
    this.toolRegistry = config.toolRegistry;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

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
    this.submitOperation({ type: 'ExecApproval', callId, approved: true, remember });
  }

  rejectExecution(callId: string): void {
    this.submitOperation({ type: 'ExecApproval', callId, approved: false });
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

    const disposeEvent: EngineEvent = {
      id: crypto.randomUUID(),
      msg: { type: 'EngineDisposed', data: { engineId: this.engineId } },
    };
    this.eventWaiters.forEach((resolve) => resolve(disposeEvent));
    this.eventWaiters.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
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
        await this.handleSubmission(submission);
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
        await this.handleUserInput(submission.id, op.items, op.context);
        break;
      case 'Interrupt':
        this.pushEvent({
          id: crypto.randomUUID(),
          msg: { type: 'TaskAborted', data: { reason: op.reason } },
        });
        break;
      case 'ExecApproval':
        this.handleExecApproval(op);
        break;
      case 'PatchApproval':
        // Protocol-level patch approval — placeholder for future implementation
        break;
      case 'Compact':
        this.pushEvent({
          id: crypto.randomUUID(),
          msg: { type: 'CompactComplete', data: { mode: op.mode ?? 'manual' } },
        });
        break;
      case 'ClearHistory':
        this.pushEvent({
          id: crypto.randomUUID(),
          msg: { type: 'HistoryCleared' },
        });
        break;
    }
  }

  private async handleUserInput(
    submissionId: string,
    items: InputItem[],
    _context?: ExecutionContext,
  ): Promise<void> {
    try {
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: { type: 'TaskStarted', data: { submissionId } },
      });

      // Build response from items
      const textContent = items
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n');

      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'TaskComplete',
          data: {
            submissionId,
            response: textContent || null,
            turnCount: 0,
            tokenUsage: undefined,
          },
        },
      });
    } catch (error) {
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

  private handleExecApproval(op: Extract<EngineOp, { type: 'ExecApproval' }>): void {
    const { callId, approved } = op;

    // Route to ApprovalGate's approval manager for risk-based decisions
    if (this.config.approvalGate) {
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'ExecApprovalHandled',
          data: { callId, approved },
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Event Handling
  // ---------------------------------------------------------------------------

  pushEvent(event: EngineEvent): void {
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

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        abortController.abort();
        this.interrupt('Cancelled');
      });
    }

    while (true) {
      const event = await this.getNextEvent();

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
