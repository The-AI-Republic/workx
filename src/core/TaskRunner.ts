/**
 * TaskRunner implementation
 * Manages task execution lifecycle, handles task cancellation, and emits progress events
 * Enhanced with AgentTask integration - contains the majority of task execution logic
 */

import { Session } from './Session';
import { TurnManager } from './TurnManager';
import { TurnContext } from './TurnContext';
import type { ProcessedResponseItem, TurnRunResult } from './TurnManager';
import type { InputItem, Event, ResponseItem } from '../protocol/types';
import type {
  EventMsg,
  TaskCompleteEvent,
  TaskStartedEvent,
  TokenUsage,
  TurnAbortReason,
  CompactionCompletedEvent,
} from '../protocol/events';
import type { CompactionResult } from './compact/types';

/**
 * Task state for tracking execution
 */
export interface TaskState {
  submissionId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  currentTurnIndex: number;
  tokenUsage: {
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
}

interface LoopOutcomeInit {
  turnCount: number;
  compactionPerformed: boolean;
  lastAgentMessage?: string;
  totalTokenUsage?: TokenUsage;
  lastTokenUsage?: TokenUsage;
  abortedReason?: TurnAbortReason;
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
  private static readonly MAX_TURNS = 500;
  private static readonly COMPACTION_THRESHOLD = 0.90; // Updated from 0.75 to 0.90 per spec

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
      tokenUsage: {
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
    this.state.status = 'cancelled';
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
      this.state.tokenUsage.used = 0;
      this.state.currentTurnIndex = 0;
      this.state.tokenUsageDetail = undefined;
      this.state.lastAgentMessage = undefined;

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
      this.session.recordInputAndRolloutUsermsg(this.input);

      const outcome = await this.runLoop(signal);

      this.state.currentTurnIndex = outcome.turnCount;
      this.state.compactionPerformed = outcome.compactionPerformed;
      this.state.lastAgentMessage = outcome.lastAgentMessage;
      this.state.tokenUsageDetail = outcome.tokenUsage;
      this.state.tokenUsage.used = outcome.tokenUsage.total
        ? outcome.tokenUsage.total.total_tokens
        : 0;

      if (outcome.abortedReason) {
        this.state.status = 'cancelled';
        this.state.abortReason = outcome.abortedReason;
        if (outcome.abortedReason === 'automatic_abort') {
          await this.emitBackgroundEvent(
            `Task stopped after reaching the maximum of ${TaskRunner.MAX_TURNS} turns`,
            'warning'
          );
        }
        await this.emitAbortedEvent(outcome.abortedReason);

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
      this.state.status = this.cancelled ? 'cancelled' : 'failed';
      this.state.lastError = err;

      if (this.cancelled && !this.state.abortReason) {
        this.state.abortReason = 'user_interrupt';
        await this.emitAbortedEvent('user_interrupt');
      }

      await this.emitErrorEvent(`Task execution failed: ${err.message}`);

      return {
        success: false,
        error: err.message,
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
    let autoCompactAttempted = false;
    let totalTokenUsage: TokenUsage | undefined;
    let lastTokenUsage: TokenUsage | undefined;

    while (!this.cancelled) {
      if (signal?.aborted) {
        this.cancel();
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
          abortedReason: 'user_interrupt',
        });
      }

      if (turnCount >= TaskRunner.MAX_TURNS) {
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
          abortedReason: 'automatic_abort',
        });
      }

      const pendingInput = (await this.session.getPendingInput()) as ResponseItem[];
      const turnInput = await this.buildNormalTurnInput(pendingInput);

      if (this.cancelled) {
        return this.buildLoopOutcome({
          turnCount,
          compactionPerformed,
          lastAgentMessage,
          totalTokenUsage,
          lastTokenUsage,
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

        turnCount += 1;
        this.state.currentTurnIndex = turnCount;

        if (
          processResult.tokenLimitReached &&
          this.options.autoCompact &&
          !autoCompactAttempted
        ) {
          compactionPerformed = await this.attemptAutoCompact(turnCount, totalTokenUsage);
          autoCompactAttempted = true;
        }

        if (processResult.taskComplete) {
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
    const toolsConfig = this.turnContext.getToolsConfig();
    const enabledTools = Object.entries(toolsConfig)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name)
      .sort();

    const data: TaskStartedEvent = {
      submission_id: this.submissionId,
      model_context_window: contextWindow,
      model: this.turnContext.getModel(),
      tabId: this.session.getTabId(), // Get tabId from session (stored in SessionState)
      approval_policy: this.turnContext.getApprovalPolicy(),
      sandbox_policy: this.turnContext.getSandboxPolicy(),
      auto_compact: this.options.autoCompact !== false,
      compaction_threshold: TaskRunner.COMPACTION_THRESHOLD,
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

    await this.emitEvent({
      type: 'TaskComplete',
      data,
    });
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

      // Case 1: Assistant message without response (task complete indicator)
      if (messageItem.type === 'message' && messageItem.role === 'assistant' && !response) {
        itemsToRecord.push(messageItem);
      }
      // Case 1b: Assistant message with tool_calls and FunctionCallOutput response (unified format)
      // NEW: Chat Completions API returns message items with embedded tool_calls
      else if (
        messageItem.type === 'message' &&
        messageItem.role === 'assistant' &&
        (messageItem as any).tool_calls &&
        response?.type === 'function_call_output'
      ) {
        taskComplete = false;
        itemsToRecord.push(messageItem);
        itemsToRecord.push(response as ResponseItem);
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

    // Extract last assistant message from recorded items
    const lastAgentMessage = this.getLastAssistantMessageFromTurn(itemsToRecord);

    // Check token limits
    const contextWindow = this.turnContext.getModelContextWindow();
    const tokenLimitReached = Boolean(
      totalTokenUsage &&
      contextWindow &&
      totalTokenUsage.total_tokens >= contextWindow * TaskRunner.COMPACTION_THRESHOLD
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
   * Attempt automatic compaction when token limit is reached
   */
  private async attemptAutoCompact(turnIndex: number, usage?: TokenUsage): Promise<boolean> {
    const usageNote = usage ? ` (tokens: ${usage.total_tokens}/${this.state.tokenUsage.max})` : '';

    try {
      // Get model client for LLM-based summarization
      const modelClient = this.turnContext.getModelClient();

      const result = await this.session.compact('auto', modelClient);

      // Emit compaction completed event for UI notification
      await this.notifyCompactionComplete(result);

      // FR-009: Invalidate cached token state after successful compaction
      // Update state to reflect post-compaction token count
      if (result.success) {
        this.state.tokenUsage.used = result.tokensAfter;
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
      id: this.submissionId,
      msg,
    };
    await this.session.emitEvent(event);
  }

  /**
   * Emit task aborted event
   */
  private async emitAbortedEvent(reason: TurnAbortReason): Promise<void> {
    await this.emitEvent({
      type: 'TurnAborted',
      data: {
        reason,
        submission_id: this.submissionId,
        turn_count: this.state.currentTurnIndex,
      },
    });
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
      used: this.state.tokenUsage.used,
      max: this.state.tokenUsage.max,
      compactionThreshold: TaskRunner.COMPACTION_THRESHOLD,
    };
  }
}
