/**
 * CompactService - main orchestration service for chat history compaction
 */

import type { ResponseItem } from '../protocol/types';
import type {
  CompactionConfig,
  CompactionResult,
  CompactedHistory,
  CompactionTrigger,
} from './types';
import { DEFAULT_COMPACTION_CONFIG, SUMMARIZATION_PROMPT } from './constants';
import { SummaryGenerator } from './SummaryGenerator';
import { HistoryReconstructor } from './HistoryReconstructor';
import { calculateBackoff, sleep } from './utils';
import { withModelRetry } from '../models/resilience/withRetry';
import type { ModelClient } from '../models/ModelClient';
import { isOutputTextDelta, isCompleted } from '../models/types/ResponseEvent';

// Track 05b: compaction interlock + summary hint
import {
  EXTRACTION_WAIT_TIMEOUT_MS,
  EXTRACTION_STALE_THRESHOLD_MS,
} from '../sessionSummary/sessionSummaryUtils';
import { waitForSessionSummaryExtraction } from '../sessionSummary/extractionLifecycle';
import { isSessionSummaryEmpty } from '../sessionSummary/SessionSummaryFileStore';
import { truncateSessionSummaryForCompact } from '../sessionSummary/truncate';
import type { SessionSummaryHook } from '../sessionSummary/SessionSummaryHook';
import type { SessionSummaryTelemetryName } from '../protocol/events';

/**
 * Track 05b: opt-in extras the caller (Session) threads through. Optional
 * so existing direct callers / test fixtures of `CompactService.compact()`
 * don't have to update.
 */
export interface CompactExtras {
  sessionId?: string;
  sessionSummaryHook?: SessionSummaryHook | null;
}

/**
 * Main service for orchestrating chat history compaction
 */
export class CompactService {
  private config: CompactionConfig;
  private summaryGenerator: SummaryGenerator;
  private historyReconstructor: HistoryReconstructor;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this.summaryGenerator = new SummaryGenerator();
    this.historyReconstructor = new HistoryReconstructor();
  }

  /**
   * Check if compaction should be triggered based on current token usage.
   *
   * @param currentTokens - Current total token usage
   * @param contextWindow - Model's context window size
   * @returns true if auto-compaction should trigger
   */
  shouldCompact(currentTokens: number, contextWindow: number): boolean {
    if (!contextWindow || contextWindow <= 0) {
      return false;
    }

    const threshold = contextWindow * this.config.triggerThreshold;
    const shouldTrigger = currentTokens >= threshold;

    if (shouldTrigger) {
      console.debug('[Compaction] Threshold check:', {
        currentTokens,
        contextWindow,
        threshold,
        triggerThreshold: this.config.triggerThreshold,
        shouldTrigger,
      });
    }

    return shouldTrigger;
  }

  /**
   * Execute compaction on the current conversation history.
   *
   * @param history - Current conversation history
   * @param trigger - What triggered this compaction
   * @param modelClient - Model client for LLM-based summarization
   * @param tokensBefore - Current token count (for metrics)
   * @param baseInstructions - Base instructions (agent_prompt.md) to include in summarization request
   * @returns CompactionResult with success/failure and metrics
   */
  async compact(
    history: ResponseItem[],
    trigger: CompactionTrigger,
    modelClient: ModelClient,
    tokensBefore: number = 0,
    baseInstructions?: string,
    extras?: CompactExtras,
  ): Promise<CompactionResult> {
    console.debug('[Compaction] Starting', {
      trigger,
      tokensBefore,
      historyLength: history.length,
    });

    // Track 05b: compaction interlock. If a summary extraction is mid-write
    // for this session, wait up to 15s for it to finish before destructively
    // rewriting history. After the wait, read the (possibly fresh) summary
    // file and fold its content into the summarization prompt as a hint.
    const sessionId = extras?.sessionId;
    const summaryHook = extras?.sessionSummaryHook;
    let sessionSummaryHint: string | undefined;

    if (sessionId) {
      const waitResult = await waitForSessionSummaryExtraction(sessionId);
      if (waitResult === 'timeout') {
        this.emitSummaryTelemetry(
          summaryHook,
          'compact_extraction_wait_timeout',
          sessionId,
          { waited_ms: EXTRACTION_WAIT_TIMEOUT_MS },
        );
      } else if (waitResult === 'stale') {
        this.emitSummaryTelemetry(
          summaryHook,
          'compact_extraction_wait_timeout',
          sessionId,
          {
            waited_ms: EXTRACTION_STALE_THRESHOLD_MS,
            stale: true,
          },
        );
      }

      // Pick up whatever the latest summary on disk is (or empty if missing).
      if (summaryHook) {
        const fresh = await summaryHook.readSummaryFromDisk();
        if (fresh && !isSessionSummaryEmpty(fresh)) {
          sessionSummaryHint = truncateSessionSummaryForCompact(fresh);
        } else {
          this.emitSummaryTelemetry(
            summaryHook,
            'compact_skipped_empty_summary',
            sessionId,
            {},
          );
        }
      }
    }

    let workingHistory = [...history];
    let itemsTrimmed = 0;
    let retriesUsed = 0;

    // Track 12: transient-error retry/backoff is delegated to the single
    // orchestrator. The outer loop is retained only for the bespoke
    // context-overflow self-heal (trim oldest item and re-summarize), which
    // is domain logic, not a transient retry.
    for (;;) {
      let summaryText: string;
      try {
        summaryText = await withModelRetry(
          () =>
            this.generateSummaryWithModel(
              workingHistory,
              modelClient,
              baseInstructions,
              sessionSummaryHint,
            ),
          {
            maxRetries: this.config.maxRetries,
            unattended: false,
            // 'compact' is a foreground-retry source (claudy parity): a
            // failed compaction blocks progress, so retry 429/529 rather
            // than fast-bail.
            source: 'foreground',
            sleep: (ms) => sleep(ms),
            computeBackoffMs: (attempt) =>
              calculateBackoff(attempt, this.config.baseBackoffMs),
            // Context-overflow is self-healed by trimming below, not by
            // retrying the same oversized input.
            isNonRetryable: (e) =>
              this.isContextOverflowError(
                e instanceof Error ? e.message : String(e),
              ),
            onRetryNotice: () => {
              retriesUsed++;
            },
          },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Context overflow: trim oldest item and re-summarize (not a retry).
        if (
          this.isContextOverflowError(errorMessage) &&
          workingHistory.length > 1
        ) {
          console.debug('[Compaction] Context overflow, trimming oldest item');
          workingHistory = this.trimOldestItem(workingHistory);
          itemsTrimmed++;
          continue;
        }

        console.error('[Compaction] Failed after max retries', {
          error: errorMessage,
          retriesUsed,
        });
        return {
          success: false,
          tokensBefore,
          tokensAfter: tokensBefore,
          itemsTrimmed,
          error: errorMessage,
          retriesUsed,
          triggerReason: trigger,
        };
      }

      {
        // Collect and select user messages
        const userMessages = this.summaryGenerator.collectUserMessages(workingHistory);
        const selectedMessages = this.historyReconstructor.selectUserMessages(
          userMessages,
          this.config
        );

        // Format summary with prefix
        const formattedSummary = this.summaryGenerator.formatSummaryWithPrefix(
          summaryText || ''
        );

        // Build compacted history
        const initialContext = this.historyReconstructor.extractInitialContext(workingHistory);
        const compactedHistory = this.historyReconstructor.buildHistory(
          initialContext,
          selectedMessages.messages,
          formattedSummary
        );

        // Convert to flat array and estimate new token count
        const newHistory = this.historyReconstructor.toResponseItems(compactedHistory);
        const tokensAfter = this.estimateTokens(newHistory);

        const result: CompactionResult = {
          success: true,
          tokensBefore,
          tokensAfter,
          itemsTrimmed,
          summaryText: formattedSummary,
          newHistory,
          retriesUsed,
          triggerReason: trigger,
        };

        console.debug('[Compaction] Complete', {
          success: true,
          tokensBefore,
          tokensAfter,
          itemsTrimmed,
          retriesUsed,
          trigger,
        });

        // Track 05b: emit telemetry when the summary hint was folded in.
        if (sessionId && sessionSummaryHint) {
          this.emitSummaryTelemetry(
            summaryHook,
            'compact_with_summary',
            sessionId,
            {
              tokens_before: tokensBefore,
              tokens_after: tokensAfter,
              summary_token_count: Math.ceil(sessionSummaryHint.length / 4),
            },
          );
        }

        return result;
      }
    }
  }

  /**
   * Build the compacted history structure from compaction result.
   * Public interface for external use.
   *
   * @param history - Original history
   * @param summaryText - Generated summary text
   * @returns CompactedHistory ready to convert to ResponseItems
   */
  buildCompactedHistory(history: ResponseItem[], summaryText: string): CompactedHistory {
    const userMessages = this.summaryGenerator.collectUserMessages(history);
    const selectedMessages = this.historyReconstructor.selectUserMessages(userMessages, this.config);
    const initialContext = this.historyReconstructor.extractInitialContext(history);

    return this.historyReconstructor.buildHistory(
      initialContext,
      selectedMessages.messages,
      summaryText
    );
  }

  /**
   * Get current compaction configuration.
   */
  getConfig(): CompactionConfig {
    return { ...this.config };
  }

  /**
   * Update compaction configuration.
   *
   * @param config - Partial config to merge with current
   */
  updateConfig(config: Partial<CompactionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the history reconstructor for direct access.
   */
  getHistoryReconstructor(): HistoryReconstructor {
    return this.historyReconstructor;
  }

  /**
   * Generate summary text using the model client.
   * Streams the LLM response and collects the summary text.
   *
   * @param history - Conversation history to summarize
   * @param modelClient - Model client for LLM calls
   * @param baseInstructions - Base instructions (agent_prompt.md) to include in request
   * @returns Generated summary text
   */
  private async generateSummaryWithModel(
    history: ResponseItem[],
    modelClient: ModelClient,
    baseInstructions?: string,
    sessionSummaryHint?: string,
  ): Promise<string> {
    // Track 05b: when a session-summary hint is available, prepend it to the
    // summarization prompt so the LLM has the running narrative in hand
    // before it summarizes. The hint is already truncated by the caller; we
    // just wrap it in a clear delimiter.
    const promptText =
      sessionSummaryHint && sessionSummaryHint.length > 0
        ? `${SUMMARIZATION_PROMPT}

The following is a running session-summary distilled from earlier in this conversation. Use it as context but produce your own summary that captures the conversation in full:

<session_summary>
${sessionSummaryHint}
</session_summary>`
        : SUMMARIZATION_PROMPT;

    // Build summary request: history + summarization prompt
    const summaryRequest: ResponseItem[] = [
      ...history,
      {
        type: 'message' as const,
        role: 'user',
        content: [{ type: 'input_text' as const, text: promptText }],
      },
    ];

    // Stream the response and collect text
    // Include base_instructions_override so the compact LLM has full agent context
    const stream = await modelClient.stream({
      input: summaryRequest,
      tools: [], // No tools needed for summarization
      base_instructions_override: baseInstructions,
    });

    let summaryText = '';

    for await (const event of stream) {
      if (isOutputTextDelta(event)) {
        summaryText += event.delta;
      }
      if (isCompleted(event)) {
        break;
      }
    }

    return summaryText.trim();
  }

  /**
   * Track 05b: emit a SessionSummaryTelemetry event through the hook's
   * public emitter. Falls back to a no-op when no hook is wired up — tests
   * and direct callers won't see telemetry, which is fine.
   *
   * `sessionId` is logged but the hook already knows its own session, so
   * it isn't passed through.
   */
  private emitSummaryTelemetry(
    hook: SessionSummaryHook | null | undefined,
    event: SessionSummaryTelemetryName,
    _sessionId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!hook) return;
    try {
      hook.emitTelemetry(event, payload);
    } catch (err) {
      console.warn(
        '[Compaction] session-summary telemetry emit failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Check if an error indicates context window overflow.
   */
  private isContextOverflowError(errorMessage: string): boolean {
    const overflowPatterns = [
      'context_length_exceeded',
      'maximum context length',
      'token limit',
      'context window',
      'too many tokens',
    ];

    const lowerError = errorMessage.toLowerCase();
    return overflowPatterns.some((pattern) => lowerError.includes(pattern));
  }

  /**
   * Trim the oldest non-initial-context item from history.
   */
  private trimOldestItem(history: ResponseItem[]): ResponseItem[] {
    const initialContext = this.historyReconstructor.extractInitialContext(history);
    const rest = history.slice(initialContext.length);

    if (rest.length > 0) {
      // Remove first item after initial context
      return [...initialContext, ...rest.slice(1)];
    }

    // If only initial context remains, remove from initial context
    if (initialContext.length > 1) {
      return initialContext.slice(1);
    }

    return history;
  }

  /**
   * Estimate token count for a history array.
   */
  private estimateTokens(history: ResponseItem[]): number {
    let total = 0;

    for (const item of history) {
      if ('content' in item && Array.isArray(item.content)) {
        for (const c of item.content as Array<{ type: string; text?: string }>) {
          if (c.text) {
            // Rough estimate: 1 token per 4 characters
            total += Math.ceil(c.text.length / 4);
          }
        }
      }
    }

    return total;
  }
}
