/**
 * Trigger-predicate and tunable constants for session-summary extraction.
 *
 * Design parity with claudy's services/SessionMemory/sessionMemoryUtils.ts:
 *   minimumMessageTokensToInit, minimumTokensBetweenUpdate, toolCallsBetweenUpdates
 *
 * WorkX defaults are higher (15k / 8k / 5 vs claudy's 10k / 5k / 3) because
 * browser turns routinely include large DOM snapshots, screenshots, and
 * page_text dumps that inflate per-turn token usage relative to code-only
 * sessions.
 *
 * Token counting is items-only — see estimateRequestTokens() in
 * src/core/compact/utils.ts. This deliberately mirrors claudy's
 * tokenCountWithEstimation(messages) (messages-only).
 */

import { estimateRequestTokens } from '../compact/utils';
import type { ResponseItem } from '../protocol/types';

/** Default trigger thresholds. */
export const DEFAULT_SESSION_SUMMARY_CONFIG = {
  /** First extraction only fires after this many message tokens. */
  minimumMessageTokensToInit: 15_000,
  /** Subsequent extractions require this much token growth since the last one. */
  minimumTokensBetweenUpdate: 8_000,
  /** And this many tool calls since the last extraction. */
  toolCallsBetweenUpdates: 5,
} as const;

export type SessionSummaryConfig = typeof DEFAULT_SESSION_SUMMARY_CONFIG;

/** Hard wait, staleness escape, and poll interval for the compaction interlock. */
export const EXTRACTION_WAIT_TIMEOUT_MS = 15_000;
export const EXTRACTION_STALE_THRESHOLD_MS = 60_000;
export const EXTRACTION_POLL_INTERVAL_MS = 1_000;

/** Per-session bookkeeping carried between extractions. */
export interface ExtractionState {
  initialized: boolean;
  tokensAtLastExtraction: number;
  toolCallsAtLastExtraction: number;
}

export function createInitialExtractionState(): ExtractionState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    toolCallsAtLastExtraction: 0,
  };
}

/**
 * Count tool calls in the entire history. Cheap; the per-turn delta is
 * computed by subtracting `state.toolCallsAtLastExtraction`.
 */
export function countToolCalls(history: ResponseItem[]): number {
  let n = 0;
  for (const item of history) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      n++;
    }
    if (
      item.type === 'message' &&
      'tool_calls' in item &&
      Array.isArray((item as { tool_calls?: unknown[] }).tool_calls)
    ) {
      n += (item as { tool_calls: unknown[] }).tool_calls.length;
    }
  }
  return n;
}

/**
 * Decide whether to fire the extractor for the just-completed turn.
 *
 * Returns true when:
 *  - token threshold AND tool-call threshold both met, OR
 *  - token threshold met AND the last turn produced no tool calls (natural pause)
 *
 * The token threshold is always required. The tool-call threshold is
 * relaxed at natural conversation breaks so we don't miss extractions when
 * the user/model just stop running tools.
 */
export function shouldExtractSessionSummary(args: {
  history: ResponseItem[];
  state: ExtractionState;
  lastTurnHadToolCalls: boolean;
  config?: SessionSummaryConfig;
}): boolean {
  const cfg = args.config ?? DEFAULT_SESSION_SUMMARY_CONFIG;
  const tokens = estimateRequestTokens(args.history);

  // Init gate: don't fire on small sessions
  if (!args.state.initialized) {
    if (tokens < cfg.minimumMessageTokensToInit) {
      return false;
    }
  }

  const tokenGrowth = tokens - args.state.tokensAtLastExtraction;
  const hasTokenThreshold = tokenGrowth >= cfg.minimumTokensBetweenUpdate;

  const totalToolCalls = countToolCalls(args.history);
  const toolCallDelta = totalToolCalls - args.state.toolCallsAtLastExtraction;
  const hasToolCallThreshold = toolCallDelta >= cfg.toolCallsBetweenUpdates;

  return (
    (hasTokenThreshold && hasToolCallThreshold) ||
    (hasTokenThreshold && !args.lastTurnHadToolCalls)
  );
}

/** Update state after a (successful or failed) extraction. */
export function recordExtractionSnapshot(
  state: ExtractionState,
  history: ResponseItem[],
): void {
  state.initialized = true;
  state.tokensAtLastExtraction = estimateRequestTokens(history);
  state.toolCallsAtLastExtraction = countToolCalls(history);
}
