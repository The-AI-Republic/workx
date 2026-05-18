// File: src/core/engine/RepublicAgentEngine.ts

import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { Session } from '../Session';
import type { Event as AgentEvent } from '../protocol/events';
import type { InputItem as ProtocolInputItem } from '../protocol/types';
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
import { CommandQueue } from '../queue/CommandQueue';
import { priorityForOp } from '../queue/priorityForOp';
import { ShadowAgentScheduler } from '../shadowAgent/ShadowAgentScheduler';

export class RepublicAgentEngine {
  readonly engineId: string;

  private config: RepublicAgentEngineConfig;
  private toolRegistry: ToolRegistry;
  private session: Session | null = null;
  private ownsSession: boolean;

  // Queue state.
  // submissionQueue: priority-aware (Track 08) — 'Interrupt'/'ExecApproval'/
  //   'PatchApproval'/'Shutdown' jump ahead of queued 'Compact'/'AddToHistory'.
  //   See src/core/queue/priorityForOp.ts.
  // eventQueue: plain FIFO — event delivery to waiters, no priority semantics.
  private submissionQueue = new CommandQueue<Submission>();
  private eventQueue: EngineEvent[] = [];
  private processingSubmission = false;
  private eventWaiters: Array<(event: EngineEvent) => void> = [];

  // Lifecycle state
  private disposed = false;
  private initialized = false;
  private shadowAgentScheduler: ShadowAgentScheduler | null = null;

  // Event listener callbacks (supports multiple listeners)
  private eventListeners: Array<(event: EngineEvent) => void> = [];

  /**
   * Notifications enqueued while no turn is active. Drained and prepended to
   * the next `run()` / `sendFollowUp()` so background sub-agent results are
   * not silently dropped when the parent is idle. See `enqueueSyntheticUserTurn`.
   */
  private pendingNotifications: string[] = [];

  constructor(config: RepublicAgentEngineConfig) {
    this.engineId = crypto.randomUUID();
    this.config = config;
    this.toolRegistry = config.toolRegistry;
    this.ownsSession = config.ownsSession ?? (config.session == null);
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error('[RepublicAgentEngine] Cannot initialize a disposed engine');
    }
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
        this.config.initialHistory,
      );
      if (typeof this.session.initialize === 'function') {
        await this.session.initialize();
      }

      // Apply config values (systemPrompt, userInstructions, model) to the session's TurnContext.
      // Without this, sub-agents would run with bare defaults instead of the
      // systemPrompt/model specified in SubAgentTypeConfig.
      // Use createClientForModelKey to honor model overrides (e.g., sub-agent configured
      // to use a different model than the parent's globally selected model).
      const modelClient = await this.config.modelClientFactory.createClientForModelKey(
        this.config.model,
      );
      const { TurnContext } = await import('../TurnContext');
      const turnContext = new TurnContext(modelClient, {
        sessionId: this.session.sessionId,
        baseInstructions: this.config.systemPrompt,
        userInstructions: this.config.userInstructions,
        approvalPolicy: this.config.approvalPolicy,
      });
      if (this.config.model) {
        turnContext.setSelectedModelKey(this.config.model);
      }
      this.session.setTurnContext(turnContext);
      if (this.config.browserContext) {
        this.session.setTabId(this.config.browserContext.tabId);
      }

      // Wire session events to the engine's event system (only for internally-owned sessions)
      this.session.setEventEmitter(async (event: AgentEvent) => {
        this.pushEvent({
          id: event.id,
          msg: event.msg as EngineEvent['msg'],
        });
      });
    }

    // Track 04: forward the shared TaskOutputStore to the session so its
    // typed-task accessors (getTaskOutputStore, retainTask, eviction timer)
    // and the engine's getTaskOutput can both reach the same backing store.
    if (this.session && this.config.taskOutputStore) {
      this.session.setTaskOutputStore(this.config.taskOutputStore);
    }

    if (this.ownsSession && this.session?.initialize) {
      await this.session.initialize();
    }

    // Setup approval system
    this.setupApprovalSystem();
    // Reuse any scheduler already handed out via getShadowAgentScheduler()
    // before initialize() ran, so the session is wired to the same instance
    // that dispose() shuts down (avoids a second, orphaned scheduler).
    this.shadowAgentScheduler ??= new ShadowAgentScheduler({ parentEngine: this });
    this.session?.setShadowAgentScheduler?.(this.shadowAgentScheduler);
    const prefs = this.config.agentConfig.getConfig?.()?.preferences as
      | { shadowCompactPrepareEnabled?: boolean }
      | undefined;
    this.session?.setShadowCompactPreparationEnabled?.(
      prefs?.shadowCompactPrepareEnabled === true,
    );

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
    this.submissionQueue.enqueue(submission, { priority: priorityForOp(op) });
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
      items: this.drainPendingNotificationsInto(input),
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
      items: this.drainPendingNotificationsInto(input),
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
    // Drop any queued submissions; in-flight callers blocked on
    // waitForCompletion() unblock either when dispose() emits EngineDisposed
    // or when their per-submission timeout fires. Notification buffer is
    // cleared so a subsequent run() doesn't pick up stale notifications from
    // a cancelled session.
    this.submissionQueue.clear();
    this.pendingNotifications.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Track 04: typed task query API
  // ---------------------------------------------------------------------------

  /**
   * Get a delta of output chunks for a tracked task. Returns chunks with
   * `seq > fromSeq`. Used by the UI panel + the parent agent's
   * "what has X done so far?" query.
   *
   * No-op (returns []) if no TaskOutputStore is configured.
   */
  async getTaskOutput(
    taskId: string,
    fromSeq: number = 0,
  ): Promise<import('../tasks/TaskOutputStore').TaskOutputChunk[]> {
    const store = this.session?.getTaskOutputStore?.();
    if (!store) return [];
    return store.getDelta(taskId, fromSeq);
  }

  /**
   * Snapshot of all typed task states currently in Session.activeTasks.
   * Includes terminal-but-unevicted tasks (still inside PANEL_GRACE_MS).
   * Used by the background-tasks badge and the parent agent's
   * list_sub_agents-style queries.
   */
  listTaskStates(): import('../tasks/types').TaskState[] {
    return this.session?.listTaskStates?.() ?? [];
  }

  /**
   * UI-driven retain toggle. Pass true on panel mount, false on unmount.
   * retain=true blocks eviction; retain=false re-arms evictAfter for
   * terminal tasks.
   */
  retainTask(taskId: string, retain: boolean): void {
    this.session?.retainTask?.(taskId, retain);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.shadowAgentScheduler?.shutdown();

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

  getShadowAgentScheduler(): ShadowAgentScheduler {
    if (!this.shadowAgentScheduler) {
      this.shadowAgentScheduler = new ShadowAgentScheduler({ parentEngine: this });
    }
    return this.shadowAgentScheduler;
  }

  /**
   * Get the current nesting depth of this engine in the sub-agent hierarchy.
   * 0 = top-level agent.
   */
  getDepth(): number {
    return this.config.depth ?? 0;
  }

  /**
   * Get the maximum allowed sub-agent nesting depth.
   */
  getMaxDepth(): number {
    return this.config.maxDepth ?? 3;
  }

  /**
   * Enqueue a synthetic user turn message (e.g. notification from a background sub-agent).
   *
   * If a turn is currently active, the text is appended to the session's
   * pending-input queue and consumed at the next drain point.
   *
   * If no turn is active, the text is buffered on the engine and prepended to
   * the input of the next `run()` / `sendFollowUp()` call, so background
   * notifications are never silently dropped when the parent is idle.
   *
   * Either way, a `SubAgentNotificationQueued` event is emitted so UI/event
   * consumers can react immediately.
   */
  enqueueSyntheticUserTurn(text: string): void {
    if (this.session?.isActiveTurn()) {
      this.session.addPendingInput([{ type: 'text', text }]);
    } else {
      this.pendingNotifications.push(text);
    }
    this.pushEvent({
      id: crypto.randomUUID(),
      msg: {
        type: 'SubAgentNotificationQueued',
        data: { text },
      },
    });
  }

  /**
   * Drain any pending notification text accumulated while idle and prepend it
   * to the caller's input so the next turn sees the notifications first.
   */
  private drainPendingNotificationsInto(input: InputItem[]): InputItem[] {
    if (this.pendingNotifications.length === 0) return input;
    const notifications = this.pendingNotifications.splice(0);
    return [
      ...notifications.map((text) => ({ type: 'text' as const, text })),
      ...input,
    ];
  }

  /**
   * Create a child engine for sub-agent execution.
   * Shares parent's model client factory and agent config.
   * Caller provides restricted tool registry, event router, etc.
   */
  createChildEngine(childConfig: {
    toolRegistry: ToolRegistry;
    systemPrompt: string;
    model?: string;
    maxTurns?: number;
    approvalPolicy?: RepublicAgentEngineConfig['approvalPolicy'];
    approvalGate?: RepublicAgentEngineConfig['approvalGate'];
    browserContext?: RepublicAgentEngineConfig['browserContext'];
    eventRouter?: RepublicAgentEngineConfig['eventRouter'];
    depth?: number;
    maxDepth?: number;
    drainPendingMessages?: () => string[];
    initialHistory?: RepublicAgentEngineConfig['initialHistory'];
    /** (Track 04) Inherit parent's TaskOutputStore so sub-agent's TaskRunner writes chunks. */
    taskOutputStore?: RepublicAgentEngineConfig['taskOutputStore'];
  }): RepublicAgentEngine {
    return new RepublicAgentEngine({
      agentConfig: this.config.agentConfig,
      modelClientFactory: this.config.modelClientFactory,
      toolRegistry: childConfig.toolRegistry,
      systemPrompt: childConfig.systemPrompt,
      model: childConfig.model ?? this.config.model,
      maxTurns: childConfig.maxTurns,
      approvalPolicy: childConfig.approvalPolicy,
      approvalGate: childConfig.approvalGate,
      persistent: false,
      browserContext: childConfig.browserContext,
      eventRouter: childConfig.eventRouter,
      parentEngineId: this.engineId,
      depth: childConfig.depth ?? (this.getDepth() + 1),
      maxDepth: childConfig.maxDepth ?? this.getMaxDepth(),
      drainPendingMessages: childConfig.drainPendingMessages,
      initialHistory: childConfig.initialHistory,
      taskOutputStore: childConfig.taskOutputStore ?? this.config.taskOutputStore,
    });
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
        const queued = this.submissionQueue.dequeue();
        if (!queued) break;
        const submission = queued.payload;
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
        await this.handleUserInput(submission.id, op.type, op.items, op.context, op.contextOverrides);
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
        await this.handleCompact(op.mode ?? 'auto');
        break;
      case 'ManualCompact':
        await this.handleCompact('manual');
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
    opType: 'UserInput' | 'UserTurn',
    items: InputItem[],
    _context?: ExecutionContext,
    contextOverrides?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.session) {
      throw new Error('Engine session not initialized');
    }

    try {
      // Convert engine InputItem[] to protocol InputItem[] for Session compatibility.
      // Engine types: text/image(data,mimeType)/file(path)
      // Protocol types: text/image(image_url)/clipboard(content)/context(path)
      const protocolItems: ProtocolInputItem[] = items.map(item => {
        switch (item.type) {
          case 'image': {
            const mimeType = item.mimeType ?? 'image/png';
            const data = item.data ?? '';
            return { type: 'image' as const, image_url: `data:${mimeType};base64,${data}` };
          }
          case 'file':
            return { type: 'context' as const, path: item.path };
          case 'text':
          default:
            return { type: 'text' as const, text: item.text ?? '' };
        }
      });

      // Only add pending input for UserInput (interactive user input that may
      // interrupt an ongoing turn). UserTurn is a programmatic submission that
      // should not push pending input to the active turn.
      if (opType === 'UserInput') {
        this.session.addPendingInput(protocolItems);
      }

      // Apply context overrides if provided
      if (contextOverrides) {
        this.session.updateTurnContext(contextOverrides);
      }

      const turnContext = this.session.getTurnContext();
      if (!turnContext) {
        throw new Error('Turn context not initialized');
      }

      // Create RegularTask and delegate to Session.spawnTask()
      // Pass maxTurns from engine config so sub-agents enforce their turn limits.
      const { RegularTask } = await import('../tasks/RegularTask');
      const task = new RegularTask({
        maxTurns: this.config.maxTurns,
        drainPendingMessages: this.config.drainPendingMessages,
      });

      await this.session.spawnTask(task, turnContext, submissionId, protocolItems);

      // Session.spawnTask() is fire-and-forget.
      // Task completion/abort events are emitted by Session via the event emitter
      // we wired in initialize().
    } catch (error) {
      console.error('[RepublicAgentEngine] Error processing user input:', error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Provide user-friendly message for common errors
      let userFriendlyMessage = errorMessage;
      if (errorMessage.includes('No API key configured')) {
        let providerName = 'the selected provider';
        try {
          const configData = this.config.agentConfig.getConfig();
          const modelData = this.config.agentConfig.getModelByKey(configData.selectedModelKey);
          if (modelData) {
            providerName = modelData.provider.name;
          }
        } catch (_e) {
          // Ignore error getting provider name
        }
        userFriendlyMessage = `Cannot execute task: No API key configured for ${providerName}. Please go to Settings → Model Configuration and add your API key.`;
      }

      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'TurnAborted',
          data: {
            reason: 'error' as const,
            submission_id: submissionId,
            message: userFriendlyMessage,
          },
        },
      });
      // Re-throw so processSubmissionQueue's outer catch emits the Error event,
      // matching the old two-event pattern (TurnAborted + Error) that consumers rely on.
      throw error;
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
    this.submissionQueue.clear();

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
      // Emit TurnAborted so waitForCompletion() unblocks instead of hanging
      this.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'TurnAborted',
          data: {
            reason: 'error' as const,
            message: `Approval could not be routed for call ${callId} — no pending request found`,
          },
        },
      });
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
    this.submissionQueue.clear();
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

      // Re-queue events targeted at a different submission so concurrent
      // waitForCompletion() callers don't lose their completion signals.
      const eventSubmissionId = (event.msg.data as { submission_id?: string } | undefined)?.submission_id;
      if (eventSubmissionId && eventSubmissionId !== submissionId &&
          (event.msg.type === 'TaskComplete' || event.msg.type === 'TurnAborted')) {
        this.eventQueue.push(event);
        // Wake any other waiter blocked on getNextEvent()
        if (this.eventWaiters.length > 0) {
          const waiter = this.eventWaiters.shift()!;
          const queuedEvent = this.eventQueue.shift()!;
          waiter(queuedEvent);
        }
        continue;
      }

      // Protocol uses snake_case fields: submission_id, last_agent_message, turn_count, token_usage
      if (event.msg.type === 'TaskComplete' && event.msg.data?.submission_id === submissionId) {
        const data = event.msg.data;
        const tokenUsage = data.token_usage as { total?: { input_tokens?: number; output_tokens?: number } } | undefined;
        return {
          success: true,
          response: (data.last_agent_message as string | null) ?? null,
          turnCount: (data.turn_count as number) ?? 0,
          tokenUsage: tokenUsage?.total ? {
            input_tokens: tokenUsage.total.input_tokens ?? 0,
            output_tokens: tokenUsage.total.output_tokens ?? 0,
            total_tokens: (tokenUsage.total.input_tokens ?? 0) + (tokenUsage.total.output_tokens ?? 0),
          } : undefined,
          stopReason: 'completed',
          engineId: this.engineId,
          submissionId,
        };
      }

      // Session emits TurnAborted on interruption/error.
      // Only match aborts for this submission (or aborts with no submission_id,
      // which are broadcast interrupts like user_interrupt that affect all awaiters).
      if (event.msg.type === 'TurnAborted') {
        const data = event.msg.data as { reason?: string; submission_id?: string; message?: string; turn_count?: number } | undefined;
        // Events for other submissions are already re-queued above
        if (data?.reason === 'error') {
          return {
            success: false,
            response: null,
            turnCount: 0,
            tokenUsage: undefined,
            stopReason: 'error',
            error: data.message as string,
            engineId: this.engineId,
            submissionId,
          };
        }
        return {
          success: false,
          response: null,
          turnCount: (data?.turn_count as number) ?? 0,
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
