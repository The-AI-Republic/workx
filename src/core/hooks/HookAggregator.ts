/**
 * HookAggregator — Merge results from multiple hooks fired for the same event.
 *
 * Rules (matching claudy):
 * - shouldContinue: ALL hooks must have continue !== false AND no blocking_error
 * - stopReason: first non-null from any hook
 * - updatedInput: last-writer-wins per key
 * - permissionDecision: block > approve > undefined (most restrictive wins)
 * - additionalContext / systemMessages: concatenated from all hooks
 * - totalDuration: max of all (parallel execution)
 */

import type { HookResult, AggregatedHookResult } from './types';

export class HookAggregator {
  static aggregate(results: readonly HookResult[]): AggregatedHookResult {
    let shouldContinue = true;
    let stopReason: string | undefined;
    let mergedInput: Record<string, unknown> | undefined;
    let mergedOutput: unknown;
    let hasOutput = false;
    let permissionDecision: 'approve' | 'block' | undefined;
    const additionalContext: string[] = [];
    const systemMessages: string[] = [];
    let totalDuration = 0;

    for (const result of results) {
      // Max wall-clock time (parallel execution)
      totalDuration = Math.max(totalDuration, result.duration);

      // Blocking error or explicit continue=false
      if (result.outcome === 'blocking_error' || result.continue === false) {
        shouldContinue = false;
        if (result.stopReason && !stopReason) {
          stopReason = result.stopReason;
        }
        // For blocking errors without explicit stopReason, use stderr
        if (!stopReason && result.outcome === 'blocking_error' && result.stderr) {
          stopReason = result.stderr;
        }
      }

      // Permission decision: block > approve > undefined
      if (result.decision === 'block') {
        permissionDecision = 'block';
      } else if (
        result.decision === 'approve' &&
        permissionDecision !== 'block'
      ) {
        permissionDecision = 'approve';
      }

      // Merge updatedInput (last-writer-wins per key)
      if (result.updatedInput) {
        mergedInput = { ...mergedInput, ...result.updatedInput };
      }

      // Merge updatedOutput (last wins entirely)
      if (result.updatedOutput !== undefined) {
        mergedOutput = result.updatedOutput;
        hasOutput = true;
      }

      // Collect context and messages
      if (result.additionalContext) {
        additionalContext.push(result.additionalContext);
      }
      if (result.systemMessage) {
        systemMessages.push(result.systemMessage);
      }
    }

    return {
      shouldContinue,
      stopReason,
      updatedInput: mergedInput,
      updatedOutput: hasOutput ? mergedOutput : undefined,
      additionalContext,
      systemMessages,
      permissionDecision,
      results,
      totalDuration,
    };
  }
}
