/**
 * TaskRunner implementation
 * Manages task execution lifecycle, handles task cancellation, and emits progress events
 * Enhanced with AgentTask integration - contains the majority of task execution logic
 */

import { Session } from './Session';
import { TurnManager } from './TurnManager';
import { TurnContext } from './TurnContext';
import { redactSecretsInText } from '@/core/diagnostics/redact';
import type { ProcessedResponseItem, TurnRunResult } from './TurnManager';
import type { InputItem, Event, ResponseItem } from './protocol/types';
import type {
  EventMsg,
  TaskCompleteEvent,
  TaskFailedEvent,
  TaskStartedEvent,
  TokenUsage,
  TurnAbortReason,
  CompactionCompletedEvent,
} from './protocol/events';
import type { CompactionResult } from './compact/types';
import { estimateRequestTokens } from './compact/utils';
import {
  getAutoCompactRatio,
  getAutoCompactTokenLimit,
  shouldAutoCompactTokens,
} from './compact/tokenPressure';
import { TokenUsageStore } from '@/storage/TokenUsageStore';
import type { TokenUsageRecord } from '@/storage/types';
import type { BrowserPageContext } from './platform/IPlatformAdapter';

/**
 * Task state for tracking execution
 */
export interface TaskState {
  submissionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'killed' | 'unknown';
  currentTurnIndex: number;
  /**
   * Token budget tracking (remaining capacity / compaction trigger).
   * Distinct from cumulative `tokenUsage` shape used by TaskNotification +
   * BackgroundAgentTaskState — see src/core/tasks/types.ts for that.
   */
  tokenBudget: {
    used: number;
    max: number;
  };
  compactionPerformed: boolean;
  abortReason?: TurnAbortReason;
  lastAgentMessage?: string;
  tokenUsageDetail?: {
    total?: TokenUsage;
    last?: TokenUsage;
  };
  lastError?: Error;
}

/**
 * Task execution result
 */
export interface TaskResult {
  success: boolean;
  lastAgentMessage?: string;
  error?: string;
  aborted?: boolean;
}

/**
 * Task execution options
 */
export interface TaskOptions {
  /** Task timeout in milliseconds */
  timeoutMs?: number;
  /** Auto-compact when token limit reached */
  autoCompact?: boolean;
  /** Max turns before forced stop. Overrides the static MAX_TURNS (500) default. */
  maxTurns?: number;
  /** Callback that drains cross-agent messages injected between turns */
  drainPendingMessages?: () => string[];
  /**
   * (Track 04) Optional output store. When set, the runner appends chunks
   * at turn boundaries and on terminal/abort flush so background sub-agent
   * panels can poll live progress and the output survives reloads.
   * Foreground RegularTasks leave this undefined and skip persistence.
   */
  taskOutputStore?: import('./tasks/TaskOutputStore').TaskOutputStore;
  /**
   * (Track 04) Task id for output-store writes. Distinct from `submissionId`
   * (transport-layer) — this is the stable BackgroundAgentTaskState.id /
   * runId. Required when taskOutputStore is set; ignored otherwise.
   */
  taskId?: string;
  /** Present for lifecycle-managed UserInput submissions. */
  clientMessageId?: string;
  /** Digest already computed by the manager; avoids a second canonicalization seam. */
  inputDigest?: string;
}

interface LoopOutcome {
  lastAgentMessage?: string;
  abortedReason?: TurnAbortReason;
  turnCount: number;
  compactionPerformed: boolean;
  tokenUsage: {
    total?: TokenUsage;
    last?: TokenUsage;
  };
  /** Track 18: USD cost summed across this task's turns (sibling of tokenUsage). */
  totalCostUSD?: number;
  /** Track 18: true if any turn used a model absent from the cost table. */
  costEstimated?: boolean;
}

interface LoopOutcomeInit {
  turnCount: number;
  compactionPerformed: boolean;
  lastAgentMessage?: string;
  totalTokenUsage?: TokenUsage;
  lastTokenUsage?: TokenUsage;
  abortedReason?: TurnAbortReason;
  totalCostUSD?: number;
  costEstimated?: boolean;
}

/**
 * Build a human-readable description of a thrown value for the TaskFailed event,
 * so the UI never shows a bare "Task failed" with no reason. Prefers the error
 * message; falls back to the error name/constructor when the message is empty
 * (some model/gateway clients throw with an empty message), and appends the
 * cause when present.
 */
export function describeTaskError(error: unknown): string {
  // Single exit through the secret redactor: whatever reason we build below,
  // it must never surface a credential (a Bearer token, api key, etc.) in the
  // TaskFailed message shown to the user.
  return redactSecretsInText(describeTaskErrorRaw(error));
}

function describeTaskErrorRaw(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? error.name : '';
    const message = (error.message ?? '').trim();
    let text = message
      ? name && !message.startsWith(name)
        ? `${name}: ${message}`
        : message
      : name || error.constructor?.name || 'Unknown error';
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? (cause.message || cause.name || '').trim()
        : typeof cause === 'string'
          ? cause.trim()
          : '';
    if (causeText && !text.includes(causeText)) {
      text = `${text} (cause: ${causeText})`;
    }
    return text;
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error == null) return 'Unknown error';
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch {
    /* fall through to String() */
  }
  return String(error) || 'Unknown error';
}

/**
 * TaskRunner handles the execution of a complete task which may involve multiple turns
 * Enhanced with AgentTask coordination - maintains the majority of task execution logic
 */
export class TaskRunner {
  private session: Session;
  private turnContext: TurnContext;
  private turnManager: TurnManager;
  private submissionId: string;
  private input: InputItem[];
  private options: TaskOptions;
  private cancelled = false;
  private cancelPromise: Promise<void> | null = null;
  private cancelResolve: (() => void) | null = null;
  private state: TaskState;
  private terminalMarkerWritten = false;
  private static readonly MAX_TURNS = 500;

  constructor(
    session: Session,
    turnContext: TurnContext,
    turnManager: TurnManager,
    submissionId: string,
    input: InputItem[],
    options: TaskOptions = {}
  ) {
    this.session = session;
    this.turnContext = turnContext;
    this.turnManager = turnManager;
    this.submissionId = submissionId;
    this.input = input;
    this.options = {
      autoCompact: true,
      ...options,
    };

    // Set up cancellation mechanism
    this.cancelPromise = new Promise<void>((resolve) => {
      this.cancelResolve = resolve;
    });

    const contextWindow = this.turnContext.getModelContextWindow() ?? 100000;
    this.state = {
      submissionId,
      status: 'idle',
      currentTurnIndex: 0,
      tokenBudget: {
        used: 0,
        max: contextWindow,
      },
      compactionPerformed: false,
    };
  }

  /**
   * Cancel the running task
   */
  cancel(): void {
    this.cancelled = true;
    this.turnManager.cancel();
    if (this.cancelResolve) {
      this.cancelResolve();
    }
    this.state.status = 'killed';
    this.state.abortReason = 'user_interrupt';
  }

  /**
   * Check if task is cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Run the task - main execution method
   */
  async run_task(submissionId?: string, signal?: AbortSignal): Promise<TaskResult> {
    // Handle submission ID update if provided
    if (submissionId && submissionId !== this.submissionId) {
      this.state.submissionId = submissionId;
    }

    // Set up abort handler for signal if provided
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => this.cancel();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      this.state.status = 'running';
      this.state.abortReason = undefined;
      this.state.compactionPerformed = false;
      this.state.tokenBudget.used = 0;
      this.state.currentTurnIndex = 0;
      this.state.tokenUsageDetail = undefined;
      this.state.lastAgentMessage = undefined;

      await this.persistTurnStart();
      await this.emitTaskStarted();

      // Early exit for empty input tasks
      if (this.input.length === 0) {
        this.state.status = 'completed';
        await this.emitTaskComplete({
          lastAgentMessage: undefined,
          compactionPerformed: false,
          turnCount: 0,
          tokenUsage: {},
        });
        return { success: true };
      }
      // Await the durable user item before model execution so model memory and
      // the canonical history projection cannot diverge on an accepted send.
      await this.session.recordInputAndRolloutUsermsg(
        this.input,
        this.options.clientMessageId,
      );

      const outcome = await this.runLoop(signal);

      this.state.currentTurnIndex = outcome.turnCount;
      this.state.compactionPerformed = outcome.compactionPerformed;
      this.state.lastAgentMessage = outcome.lastAgentMessage;
      this.state.tokenUsageDetail = outcome.tokenUsage;
      this.state.tokenBudget.used = outcome.tokenUsage.total
        ? outcome.tokenUsage.total.total_tokens
        : 0;

      if (outcome.abortedReason) {
        this.state.status = 'killed';
        this.state.abortReason = outcome.abortedReason;
        if (outcome.abortedReason === 'automatic_abort') {
          const maxTurns = this.options.maxTurns ?? TaskRunner.MAX_TURNS;
          await this.emitBackgroundEvent(
            `Task stopped after reaching the maximum of ${maxTurns} turns`,
            'warning'
          );
        }
        await this.emitAbortedEvent(outcome.abortedReason);

        // Fire-and-forget: persist partial token usage + cost for aborted tasks
        this.persistTokenUsage(
          outcome.tokenUsage.total,
          outcome.turnCount,
          outcome.totalCostUSD,
          outcome.costEstimated ?? false,
        );

        return {
          success: false,
          aborted: true,
          lastAgentMessage: outcome.lastAgentMessage,
        };
      }

      await this.emitTaskComplete(outcome);

      this.state.status = 'completed';
      return {
        success: true,
        lastAgentMessage: outcome.lastAgentMessage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // A descriptive reason so the UI shows more than a bare "Task failed"
      // (covers errors thrown with an empty message — name/cause are surfaced).
      const detail = describeTaskError(error);
      this.state.status = this.cancelled ? 'killed' : 'failed';
      this.state.lastError = err;

      // A thrown task has no reliable final usage, so partial cost/tokens are
      // intentionally not persisted here — only the aborted and completed
      // paths persist (unchanged from pre-cost-tracking behavior).

      // Track 04: flush pending chunks before re-throwing so polling
      // consumers see the tail of a task that died mid-turn.
      await this.flushTaskOutput();

      if (this.cancelled) {
        if (!this.state.abortReason) {
          this.state.abortReason = 'user_interrupt';
          await this.emitAbortedEvent('user_interrupt');
        }
        // A user stop is already represented by the aborted event above (which
        // the engine resolves on), so do NOT also emit TaskFailed — that would
        // render a spurious red "Task failed" entry for an intentional cancel.
      } else {
        // Emit a TERMINAL failure event (not the generic `Error` event, which
        // clears no "processing" state and resolves no awaiter — leaving the UI
        // stuck spinning). TaskFailed renders the reason and ends the turn.
        await this.emitTaskFailed(detail);
      }

      return {
        success: false,
        error: detail,
      };
    } finally {
      // Clean up abort handler if it was set up
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  private async runLoop(signal?: AbortSignal): Promise<LoopOutcome> {

    let turnCount = 0;
    let lastAgentMessage: string | undefined;
    let compactionPerformed = false;
    let totalTokenUsage: TokenUsage | undefined;
    let lastTokenUsage: TokenUsage | undefined;
    // Track 18: per-task USD accumulator, summed from each turn's cost.
    let totalCostUSD: number | undefined;
    let costEstimated = false;

    while (!this.cancelled) {
      if (signal?.aborted) {
        this.cancel();
        // Track 04: flush pending output before resolving so polling
        // consumers see the tail of an aborted run.
        await this.flushTaskOutput();
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
          totalCostUSD,
          costEstimated,
          abortedReason: 'user_interrupt',
        });
      }

      const effectiveMaxTurns = this.options.maxTurns ?? TaskRunner.MAX_TURNS;
      if (turnCount >= effectiveMaxTurns) {
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
          totalCostUSD,
          costEstimated,
          abortedReason: 'automatic_abort',
        });
      }

      // Drain cross-agent messages FIRST so they land in this turn, not the
      // next one. Pushing into addPendingInput after getPendingInput() has
      // already snapshotted the queue would silently defer drained messages
      // by a full turn (or lose them entirely on the final turn).
      if (this.options.drainPendingMessages) {
        const messages = this.options.drainPendingMessages();
        if (messages.length > 0) {
          this.session.addPendingInput(
            messages.map(msg => ({ type: 'text' as const, text: msg }))
          );
        }
      }

      const pendingInput = (await this.session.getPendingInput()) as ResponseItem[];

      let turnInput = await this.buildNormalTurnInput(pendingInput);

      // Pre-request compaction check: estimate tokens and compact if needed
      if (this.options.autoCompact && this.shouldCompactBeforeRequest(turnInput)) {
        const compacted = await this.attemptAutoCompact(turnCount, totalTokenUsage);
        if (compacted) {
          compactionPerformed = true;
          turnInput = await this.buildNormalTurnInput([]);
          // Track 04: record the compaction in the chunk stream.
          await this.appendTaskOutputEvent({
            kind: 'compaction',
            stage: 'pre_request',
            turn: turnCount,
          });
        }
      }

      if (this.cancelled) {
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
          totalCostUSD,
          costEstimated,
          abortedReason: 'user_interrupt',
        });
      }

      try {
        const turnResult = await this.runTurnWithTimeout(turnInput, signal);
        const processResult = await this.processTurnResult(turnResult);

        lastAgentMessage = processResult.lastAgentMessage ?? lastAgentMessage;
        if (turnResult.totalTokenUsage) {
          totalTokenUsage = this.aggregateTokenUsage(totalTokenUsage, turnResult.totalTokenUsage);
          lastTokenUsage = turnResult.totalTokenUsage;
        }
        // Track 18: fold this turn's USD cost into the per-task total.
        if (typeof turnResult.turnCostUSD === 'number') {
          totalCostUSD = (totalCostUSD ?? 0) + turnResult.turnCostUSD;
          if (turnResult.turnCostEstimated) {
            costEstimated = true;
          }
        }

        turnCount += 1;
        this.state.currentTurnIndex = turnCount;

        // Track 04: emit per-turn event chunk + the assistant message (if any).
        await this.appendTaskOutputEvent({
          kind: 'turn',
          index: turnCount,
          tokens: lastTokenUsage,
        });
        if (processResult.lastAgentMessage) {
          await this.appendTaskOutputChunk('message', processResult.lastAgentMessage);
        }

        if (processResult.tokenLimitReached && this.options.autoCompact) {
          const compacted = await this.attemptAutoCompact(turnCount, totalTokenUsage);
          if (compacted) {
            compactionPerformed = true;
            await this.appendTaskOutputEvent({
              kind: 'compaction',
              stage: 'post_turn',
              turn: turnCount,
            });
          }
        }

        if (processResult.taskComplete) {
          await this.appendTaskOutputEvent({ kind: 'complete', turn: turnCount });
          await this.flushTaskOutput();
          return this.buildLoopOutcome({
            turnCount,
            compactionPerformed,
            lastAgentMessage,
            totalTokenUsage,
            lastTokenUsage,
          });
        }
      } catch (error) {
        if (this.cancelled || signal?.aborted) {
          if (!this.cancelled) {
            this.cancel();
          }
          return this.buildLoopOutcome({
            turnCount,
            compactionPerformed,
            lastAgentMessage,
            totalTokenUsage,
            lastTokenUsage,
            abortedReason: 'user_interrupt',
          });
        }

        throw error;
      }
    }

    return this.buildLoopOutcome({
      turnCount,
      compactionPerformed,
      lastAgentMessage,
      totalTokenUsage,
      lastTokenUsage,
      abortedReason: 'user_interrupt',
    });
  }

  private buildLoopOutcome(init: LoopOutcomeInit): LoopOutcome {
    return {
      lastAgentMessage: init.lastAgentMessage,
      abortedReason: init.abortedReason,
      turnCount: init.turnCount,
      compactionPerformed: init.compactionPerformed,
      tokenUsage: {
        total: init.totalTokenUsage,
        last: init.lastTokenUsage,
      },
      totalCostUSD: init.totalCostUSD,
      costEstimated: init.costEstimated,
    };
  }

  private aggregateTokenUsage(
    current: TokenUsage | undefined,
    next: TokenUsage
  ): TokenUsage {
    if (!current) {
      return { ...next };
    }

    return {
      input_tokens: current.input_tokens + next.input_tokens,
      cached_input_tokens: current.cached_input_tokens + next.cached_input_tokens,
      output_tokens: current.output_tokens + next.output_tokens,
      reasoning_output_tokens: current.reasoning_output_tokens + next.reasoning_output_tokens,
      total_tokens: current.total_tokens + next.total_tokens,
    };
  }

  private async emitTaskStarted(): Promise<void> {
    const contextWindow = this.turnContext.getModelContextWindow();
    const autoCompactLimit = this.turnContext.getAutoCompactTokenLimit?.();
    const toolsConfig = this.turnContext.getToolsConfig();
    const enabledTools = Object.entries(toolsConfig)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name)
      .sort();

    const registry = this.session.getToolRegistry?.();
    const pageContext: BrowserPageContext = registry
      ? await registry.getCurrentPageContext().catch((): BrowserPageContext => ({}))
      : {};
    const data: TaskStartedEvent = {
      submission_id: this.submissionId,
      model_context_window: contextWindow,
      model: this.turnContext.getModel(),
      tabId: pageContext?.tabId ?? this.turnContext.getBrowserTabId?.() ?? -1,
      approval_policy: this.turnContext.getApprovalPolicy(),
      sandbox_policy: this.turnContext.getSandboxPolicy(),
      auto_compact: this.options.autoCompact !== false,
      compaction_threshold: getAutoCompactRatio(contextWindow, autoCompactLimit),
      tools: enabledTools,
      tools_config: toolsConfig as Record<string, unknown>,
      timeout_ms: this.options.timeoutMs,
      browser_environment_policy: this.turnContext.getBrowserEnvironmentPolicy(),
    };

    const effort = this.turnContext.getEffort();
    if (effort) {
      data.reasoning_effort = effort;
    }

    const summary = this.turnContext.getSummary();
    if (summary) {
      data.reasoning_summary = summary;
    }

    await this.emitEvent({
      type: 'TaskStarted',
      data,
    });
  }

  private async emitTaskComplete(outcome: LoopOutcome): Promise<void> {
    const data: TaskCompleteEvent = {
      submission_id: this.submissionId,
      last_agent_message: outcome.lastAgentMessage,
      turn_count: outcome.turnCount,
      compaction_performed: outcome.compactionPerformed,
      aborted: false,
    };

    if (outcome.tokenUsage.total || outcome.tokenUsage.last) {
      data.token_usage = {
        total: outcome.tokenUsage.total,
        last_turn: outcome.tokenUsage.last,
      };
    }

    // Track 18: the cost computed once in core (TurnManager) rides the live
    // TaskComplete event so every consumer (UI, server per-job, desktop)
    // reads it instead of recomputing.
    if (typeof outcome.totalCostUSD === 'number') {
      data.cost_usd = outcome.totalCostUSD;
      data.cost_estimated = outcome.costEstimated ?? false;
    }

    // Reserve detached continuation leases before consumers can observe the
    // terminal event and decide the session is idle/suspendable.
    this.session.schedulePostTurnContinuations?.();

    await this.persistTerminalMarker('complete');
    await this.emitEvent({
      type: 'TaskComplete',
      data,
    });

    // Fire-and-forget: persist token usage record
    this.persistTokenUsage(
      outcome.tokenUsage.total,
      outcome.turnCount,
      outcome.totalCostUSD,
      outcome.costEstimated ?? false,
    );
  }

  /**
   * Terminal failure event. Unlike the generic `Error` event, `TaskFailed`
   * resolves the turn for every consumer: the UI clears its "processing" state
   * and renders the reason, and the engine's `waitForCompletion()` returns a
   * failure. Carries `submission_id` so the engine matches the right awaiter.
   */
  private async emitTaskFailed(message: string): Promise<void> {
    const data: TaskFailedEvent = {
      submission_id: this.submissionId,
      // All three carry the human-readable failure text. `reason` is a free
      // string some consumers read directly, so it gets the message rather than
      // a category label.
      reason: message,
      error: message,
      message,
    };
    await this.persistTerminalMarker('failed');
    await this.emitEvent({
      type: 'TaskFailed',
      data,
    });
  }

  /**
   * Track 18: the single fold-once seam. Called exactly once per task
   * (emitTaskComplete on the normal path, or the aborted path in run_task —
   * mutually exclusive). Each engine (parent and every sub-agent) self-reports
   * its own cost here; the parent's totalTokenUsage never includes sub-agent
   * tokens, so summing TokenUsageRecord.costUSD per session is double-count
   * free. Cumulative cost also lands in SessionState here via this.session.
   */
  private persistTokenUsage(
    total: TokenUsage | undefined,
    turnCount: number,
    costUSD?: number,
    costEstimated: boolean = false,
  ): void {
    try {
      const usage = total ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
      const resolvedCost = costUSD ?? 0;
      const record: TokenUsageRecord = {
        id: `${this.session.getSessionId()}_${this.submissionId}_${Date.now()}`,
        sessionId: this.session.getSessionId(),
        taskId: this.submissionId,
        model: this.turnContext.getModel(),
        // Provider-qualified key — the same model id is priced differently
        // across providers (e.g. kimi-k2-thinking on moonshot/fireworks/
        // together), so cost history must record the composite. Caveat: on a
        // Track-12 mid-task downgrade this stores only the final model, so the
        // per-model breakdown attributes the task's blended cost to it; the
        // session/day totals stay exact (they sum the per-record costUSD).
        provider_model: this.turnContext.getSelectedModelKey(),
        timestamp: new Date().toISOString(),
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.reasoning_output_tokens,
        total_tokens: usage.total_tokens,
        costUSD: resolvedCost,
        costEstimated,
        turn_count: turnCount,
      };
      TokenUsageStore.getInstance().save(record).catch((err) =>
        console.warn('[TaskRunner] Token usage save failed:', err)
      );
      // Live cumulative for /cost + resume. Same single seam — no parallel
      // path, no double-count.
      this.session.addCost(resolvedCost, costEstimated);
    } catch (err) {
      console.warn('[TaskRunner] Token usage persist failed:', err);
    }
  }

  private async emitErrorEvent(message: string): Promise<void> {
    await this.emitEvent({
      type: 'Error',
      data: { message },
    });
  }

  private async emitBackgroundEvent(
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ): Promise<void> {
    await this.emitEvent({
      type: 'BackgroundEvent',
      data: { message, level },
    });
  }

  /**
   * Run a turn with timeout support
   */
  private async runTurnWithTimeout(turnInput: ResponseItem[], signal?: AbortSignal): Promise<TurnRunResult> {
    const timeout = this.options.timeoutMs;
    const racers: Array<Promise<TurnRunResult>> = [
      this.turnManager.runTurn(turnInput),
    ];

    const cleanups: Array<() => void> = [];

    if (timeout) {
      racers.push(
        new Promise((_, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('Turn timeout')), timeout);
          cleanups.push(() => clearTimeout(timeoutId));
        }) as unknown as Promise<TurnRunResult>
      );
    }

    if (this.cancelPromise) {
      racers.push(
        this.cancelPromise.then(() => {
          throw new Error('Task cancelled');
        }) as unknown as Promise<TurnRunResult>
      );
    }

    if (signal) {
      if (signal.aborted) {
        throw new Error('Task cancelled');
      }

      racers.push(
        new Promise((_, reject) => {
          const abortHandler = () => reject(new Error('Task cancelled'));
          signal.addEventListener('abort', abortHandler, { once: true });
          cleanups.push(() => signal.removeEventListener('abort', abortHandler));
        }) as unknown as Promise<TurnRunResult>
      );
    }

    try {
      return await Promise.race(racers);
    } finally {
      cleanups.forEach(cleanup => cleanup());
    }
  }

  /**
   * Build turn input for normal mode
   */
  private async buildNormalTurnInput(pendingInput: ResponseItem[]): Promise<ResponseItem[]> {
    const turnInput = await this.session.buildTurnInputWithHistory(pendingInput);
    if (pendingInput.length > 0) {
      await this.session.recordConversationItemsDual(pendingInput);
    }
    return turnInput as ResponseItem[];
  }

  /**
   * Process the results of a turn execution
   */
  private async processTurnResult(
    turnResult: TurnRunResult
  ): Promise<{
    taskComplete: boolean;
    tokenLimitReached: boolean;
    lastAgentMessage?: string;
  }> {
    const { processedItems, totalTokenUsage } = turnResult;

    let taskComplete = true;
    const itemsToRecord: ResponseItem[] = [];

    // Process each response item
    for (const processedItem of processedItems) {
      const { item, response } = processedItem as ProcessedResponseItem;
      const messageItem = item as ResponseItem;

      // Normalize response to array for handling parallel tool calls (Gemini 3)
      const responses: any[] = Array.isArray(response) ? response : (response ? [response] : []);

      // Case 1: Assistant message without response (task complete indicator)
      if (messageItem.type === 'message' && messageItem.role === 'assistant' && responses.length === 0) {
        itemsToRecord.push(messageItem);
      }
      // Case 1b: Assistant message with tool_calls and FunctionCallOutput response(s) (unified format)
      // NEW: Chat Completions API returns message items with embedded tool_calls
      // IMPORTANT: Gemini 3 may send parallel tool calls, so we handle multiple responses
      else if (
        messageItem.type === 'message' &&
        messageItem.role === 'assistant' &&
        (messageItem as any).tool_calls &&
        responses.length > 0 &&
        responses.some(r => r?.type === 'function_call_output')
      ) {
        taskComplete = false;
        itemsToRecord.push(messageItem);
        // Add ALL function call output responses (for parallel tool calls)
        for (const resp of responses) {
          if (resp?.type === 'function_call_output') {
            itemsToRecord.push(resp as ResponseItem);
          }
        }
      }
      // Case 2: FunctionCall with FunctionCallOutput response (legacy format)
      else if (
        messageItem.type === 'function_call' &&
        response?.type === 'function_call_output'
      ) {
        taskComplete = false;
        itemsToRecord.push(messageItem);
        itemsToRecord.push(response as ResponseItem);
      }
      // Case 3: CustomToolCall with CustomToolCallOutput response
      else if (
        messageItem.type === 'custom_tool_call' &&
        response?.type === 'custom_tool_call_output'
      ) {
        taskComplete = false;
        itemsToRecord.push(messageItem);
        itemsToRecord.push(response as ResponseItem);
      }
      // Case 4: FunctionCall with McpToolCallOutput response
      // Note: In TypeScript, MCP tool outputs are converted to FunctionCallOutput
      // in the handleResponseItem method, so they follow the same pattern as Case 2

      // Case 5: Reasoning item without response
      else if (messageItem.type === 'reasoning' && !response) {
        itemsToRecord.push(messageItem);
      }
      // Case 6: Unexpected combinations (warning)
      // Rust lines 1791-1793
      else if (response) {
        console.warn(
          `Unexpected response item: ${JSON.stringify(messageItem)} with response: ${JSON.stringify(response)}`
        );
        // Still record them to avoid losing data
        taskComplete = false;
        itemsToRecord.push(messageItem);
        // Add response if it looks like a valid ResponseItem
        if (response.type) {
          itemsToRecord.push(response as ResponseItem);
        }
      }

      // Responses are handled inline above
    }

    // Record processed items in conversation history
    // Use recordConversationItemsDual to record both in-memory and persistent storage
    if (itemsToRecord.length > 0) {
      await this.session.recordConversationItemsDual(itemsToRecord);
    }

    // Post-turn hooks must observe the committed history. TurnManager builds
    // the turn delta, while TaskRunner is the first point after the in-memory
    // and durable conversation writes have completed.
    const sess = this.session as unknown as {
      firePostTurnHooks?: (ctx: unknown) => Promise<void>;
      getSessionId?: () => string;
      getConversationHistory?: () => { items: ResponseItem[] };
    };
    if (typeof sess.firePostTurnHooks === 'function') {
      const historyItems =
        typeof sess.getConversationHistory === 'function'
          ? sess.getConversationHistory().items
          : [];
      const sessionId =
        typeof sess.getSessionId === 'function' ? sess.getSessionId() : '';
      await sess.firePostTurnHooks({
        sessionId,
        history: historyItems,
        committedDelta: itemsToRecord,
        totalTokenUsage,
        lastTurnHadToolCalls: Boolean(turnResult.lastTurnHadToolCalls),
      });
    }

    // Extract last assistant message from recorded items
    const lastAgentMessage = this.getLastAssistantMessageFromTurn(itemsToRecord);

    // Check token limits
    const contextWindow = this.turnContext.getModelContextWindow();
    const autoCompactLimit = this.turnContext.getAutoCompactTokenLimit?.();
    const tokenLimitReached = Boolean(
      totalTokenUsage &&
      shouldAutoCompactTokens(totalTokenUsage.total_tokens, contextWindow, autoCompactLimit)
    );

    return {
      taskComplete,
      tokenLimitReached,
      lastAgentMessage,
    };
  }

  /**
   * Extract last assistant message text from response items
   */
  private getLastAssistantMessageFromTurn(responses: ResponseItem[]): string | undefined {
    // Iterate in reverse to find the last assistant message
    for (let i = responses.length - 1; i >= 0; i--) {
      const item = responses[i];
      if (item.type === 'message' && item.role === 'assistant') {
        // Look for output_text content in reverse order
        for (let j = item.content.length - 1; j >= 0; j--) {
          const contentItem = item.content[j];
          if (contentItem.type === 'output_text') {
            return contentItem.text;
          }
        }
      }
    }
    return undefined;
  }


  /**
   * Determine if compaction should be triggered before sending the LLM request.
   */
  private shouldCompactBeforeRequest(turnInput: ResponseItem[]): boolean {
    const contextWindow = this.turnContext.getModelContextWindow();
    if (!contextWindow) {
      return false;
    }

    const baseLen = this.turnContext.getBaseInstructions?.()?.length ?? 0;
    const userLen = this.turnContext.getUserInstructions?.()?.length ?? 0;
    const instructionsLength = baseLen + userLen;

    const toolsConfig = this.turnContext.getToolsConfig();
    const toolCount = Object.values(toolsConfig).filter(Boolean).length;
    const estimatedTokens = estimateRequestTokens(turnInput, instructionsLength, toolCount);
    const autoCompactLimit = this.turnContext.getAutoCompactTokenLimit?.();
    const threshold = getAutoCompactTokenLimit(contextWindow, autoCompactLimit);

    if (typeof threshold === 'number' && estimatedTokens >= threshold) {
      console.debug('[TaskRunner] Pre-request compaction check', {
        estimatedTokens,
        contextWindow,
        thresholdTokens: threshold,
        thresholdRatio: getAutoCompactRatio(contextWindow, autoCompactLimit),
      });
      return true;
    }

    return false;
  }

  /**
   * Attempt automatic compaction when token limit is reached
   */
  private async attemptAutoCompact(turnIndex: number, usage?: TokenUsage): Promise<boolean> {
    const usageNote = usage ? ` (tokens: ${usage.total_tokens}/${this.state.tokenBudget.max})` : '';

    try {
      // Get model client for LLM-based summarization
      const modelClient = this.turnContext.getModelClient();

      const result = await this.session.compact('auto', modelClient);

      // Emit compaction completed event for UI notification
      await this.notifyCompactionComplete(result);

      // FR-009: Invalidate cached token state after successful compaction
      // Update state to reflect post-compaction token count
      if (result.success) {
        this.state.tokenBudget.used = result.tokensAfter;
        console.debug('[TaskRunner] Token state invalidated after compaction', {
          before: result.tokensBefore,
          after: result.tokensAfter,
        });
      }

      await this.emitBackgroundEvent(
        `Context compacted at turn ${turnIndex}${usageNote}`,
        'info'
      );
      return result.success;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Auto-compact failed:', error);
      await this.emitBackgroundEvent(
        `Context compaction failed at turn ${turnIndex}: ${message}${usageNote}`,
        'warning'
      );
      return false;
    }
  }

  /**
   * Notify UI about compaction completion (T031)
   */
  private async notifyCompactionComplete(result: CompactionResult): Promise<void> {
    const compactionCount = this.session.getCompactionCount();

    const data: CompactionCompletedEvent = {
      success: result.success,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      itemsTrimmed: result.itemsTrimmed,
      compactionCount,
      triggerReason: result.triggerReason,
      error: result.error,
    };

    await this.emitEvent({
      type: 'CompactionCompleted',
      data,
    });

    // Log compaction metrics for debugging (FR-012)
    console.debug('[Compaction] Completed', {
      success: result.success,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      tokensSaved: result.tokensBefore - result.tokensAfter,
      itemsTrimmed: result.itemsTrimmed,
      compactionCount,
      triggerReason: result.triggerReason,
    });
  }

  /**
   * Emit an event through the session's event queue
   */
  private async emitEvent(msg: EventMsg): Promise<void> {
    const event: Event = {
      // Event identity is not turn identity. A task emits many snapshots and
      // lifecycle events; reusing submissionId caused keyed UI rows to replace
      // one another during replay and thread switches.
      id: crypto.randomUUID(),
      msg,
    };
    await this.session.emitEvent(event);
  }

  /**
   * Emit task aborted event
   */
  private async emitAbortedEvent(reason: TurnAbortReason): Promise<void> {
    await this.persistTerminalMarker('aborted');
    await this.emitEvent({
      type: 'TurnAborted',
      data: {
        reason,
        submission_id: this.submissionId,
        turn_count: this.state.currentTurnIndex,
      },
    });
  }

  private async persistTurnStart(): Promise<void> {
    const inputDigest = this.options.inputDigest ?? await digestInput(this.input);
    await this.session.persistRolloutItems(
      [{
        type: 'turn_start',
        payload: {
          markerVersion: 1,
          submissionId: this.submissionId,
          startedAt: Date.now(),
          ...(this.options.clientMessageId
            ? { clientMessageId: this.options.clientMessageId, inputDigest }
            : {}),
        },
      }],
      { required: true },
    );
  }

  private async persistTerminalMarker(
    outcome: 'complete' | 'failed' | 'aborted' | 'interrupted',
  ): Promise<void> {
    if (this.terminalMarkerWritten) return;
    try {
      await this.session.persistRolloutItems(
        [{
          type: 'turn_completion',
          payload: {
            markerVersion: 1,
            submissionId: this.submissionId,
            outcome,
            completedAt: Date.now(),
          },
        }],
        { required: true },
      );
      this.terminalMarkerWritten = true;
    } catch (error) {
      console.warn('[TaskRunner] terminal marker persistence failed:', error);
      this.session.reportDurabilityDegraded?.('terminal-marker-write');
    }
  }

  // ── Track 04: chunk emission helpers ─────────────────────────────────

  /**
   * Append a structured event chunk (turn boundary, compaction, complete)
   * to the task's output stream. No-op if no TaskOutputStore is configured.
   */
  private async appendTaskOutputEvent(payload: Record<string, unknown>): Promise<void> {
    const store = this.options.taskOutputStore;
    const taskId = this.options.taskId;
    if (!store || !taskId) return;
    try {
      const fromSeq = await store.getLastSeq(taskId);
      await store.appendChunk(taskId, 'event', JSON.stringify(payload), this.session.sessionId);
      await this.emitTaskOutputDelta(taskId, fromSeq, await store.getLastSeq(taskId), 'event');
    } catch (err) {
      console.warn(`[TaskRunner] appendChunk(event) failed for ${taskId}:`, err);
    }
  }

  /** Append a single chunk of a specific kind. */
  private async appendTaskOutputChunk(
    kind: 'stdout' | 'stderr' | 'event' | 'message',
    data: string,
  ): Promise<void> {
    const store = this.options.taskOutputStore;
    const taskId = this.options.taskId;
    if (!store || !taskId || data.length === 0) return;
    try {
      const fromSeq = await store.getLastSeq(taskId);
      await store.appendChunk(taskId, kind, data, this.session.sessionId);
      await this.emitTaskOutputDelta(taskId, fromSeq, await store.getLastSeq(taskId), kind);
    } catch (err) {
      console.warn(`[TaskRunner] appendChunk(${kind}) failed for ${taskId}:`, err);
    }
  }

  private async emitTaskOutputDelta(
    taskId: string,
    fromSeq: number,
    toSeq: number,
    kind: 'stdout' | 'stderr' | 'event' | 'message',
  ): Promise<void> {
    if (toSeq <= fromSeq) return;
    await this.emitEvent({
      type: 'BackgroundTaskOutputDelta',
      data: {
        taskId,
        fromSeq,
        toSeq,
        kindCounts: { [kind]: toSeq - fromSeq },
      },
    });
  }

  /** Drain pending writes in the in-memory queue. */
  private async flushTaskOutput(): Promise<void> {
    const store = this.options.taskOutputStore;
    const taskId = this.options.taskId;
    if (!store || !taskId) return;
    try {
      await store.flush(taskId);
    } catch (err) {
      console.warn(`[TaskRunner] flush failed for ${taskId}:`, err);
    }
  }

  /**
   * Get task status for a submission
   */
  getTaskStatus(_submissionId: string): TaskState['status'] {
    return this.state.status;
  }

  /**
   * Get current turn index for a submission
   */
  getCurrentTurnIndex(_submissionId: string): number {
    return this.state.currentTurnIndex;
  }

  /**
   * Get token usage for a submission
   */
  getTokenUsage(_submissionId: string): { used: number; max: number; compactionThreshold: number } {
    return {
      used: this.state.tokenBudget.used,
      max: this.state.tokenBudget.max,
      compactionThreshold: getAutoCompactRatio(
        this.turnContext.getModelContextWindow(),
        this.turnContext.getAutoCompactTokenLimit?.(),
      ),
    };
  }
}

async function digestInput(input: readonly InputItem[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
