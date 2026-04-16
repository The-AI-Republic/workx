/**
 * Tool Call Orchestration
 *
 * Partitions multi-tool responses into batches based on per-input concurrency
 * metadata, then executes safe batches concurrently and unsafe batches sequentially.
 *
 * Adapted from Claudy's toolOrchestration.ts pattern:
 * - Consecutive concurrency-safe calls merge into one batch and run in parallel.
 * - Every non-safe call becomes a singleton batch and runs alone.
 * - Batches execute in their original order.
 * - Results preserve original tool-call ordering.
 */

import type { ToolRegistry } from '../tools/ToolRegistry';

// =============================================================================
// Types
// =============================================================================

export interface PreparedToolCall {
  id: string;
  name: string;
  rawArguments: string | Record<string, unknown>;
  parsedArguments: Record<string, unknown>;
  isConcurrencySafe: boolean;
}

export interface ToolCallBatch {
  isConcurrencySafe: boolean;
  calls: PreparedToolCall[];
}

/**
 * Maximum number of safe tool calls to run in parallel within a single batch.
 * Conservative for browser context (Chrome APIs, debugger sessions, DOM, screenshots).
 */
export const MAX_SAFE_TOOL_CALL_CONCURRENCY = 5;

// =============================================================================
// Built-in Profiles
// =============================================================================

/**
 * Synthetic concurrency profile for web_search, which is special-cased in TurnManager
 * and not registered in ToolRegistry.
 */
function isWebSearchConcurrencySafe(): boolean {
  return true;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Prepare a raw tool call by parsing its arguments and classifying concurrency safety.
 */
export function prepareToolCall(
  call: { id: string; function: { name: string; arguments: string | Record<string, unknown> } },
  registry: ToolRegistry,
): PreparedToolCall {
  let parsedArguments: Record<string, unknown>;
  if (typeof call.function.arguments === 'string') {
    try {
      parsedArguments = JSON.parse(call.function.arguments);
    } catch {
      parsedArguments = {};
    }
  } else {
    parsedArguments = call.function.arguments ?? {};
  }

  let isConcurrencySafe: boolean;
  if (call.function.name === 'web_search') {
    isConcurrencySafe = isWebSearchConcurrencySafe();
  } else {
    isConcurrencySafe = registry.isConcurrencySafe(call.function.name, parsedArguments);
  }

  return {
    id: call.id,
    name: call.function.name,
    rawArguments: call.function.arguments,
    parsedArguments,
    isConcurrencySafe,
  };
}

/**
 * Partition prepared tool calls into consecutive batches.
 * Consecutive safe calls merge; non-safe calls break the batch.
 */
export function partitionToolCalls(calls: PreparedToolCall[]): ToolCallBatch[] {
  return calls.reduce((acc: ToolCallBatch[], call) => {
    if (call.isConcurrencySafe && acc.length > 0 && acc[acc.length - 1]!.isConcurrencySafe) {
      acc[acc.length - 1]!.calls.push(call);
    } else {
      acc.push({ isConcurrencySafe: call.isConcurrencySafe, calls: [call] });
    }
    return acc;
  }, []);
}

/**
 * Execute a batch of tool calls concurrently with bounded parallelism.
 * Results are returned in the same order as the input calls.
 */
export async function executeBatchConcurrently<T>(
  calls: PreparedToolCall[],
  executor: (call: PreparedToolCall) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < calls.length; i += MAX_SAFE_TOOL_CALL_CONCURRENCY) {
    const chunk = calls.slice(i, i + MAX_SAFE_TOOL_CALL_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(executor));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Execute all tool call batches, returning results in original call order.
 */
export async function executeToolCallBatches<T>(
  batches: ToolCallBatch[],
  executor: (call: PreparedToolCall) => Promise<T>,
): Promise<T[]> {
  const allResults: T[] = [];

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      const batchResults = await executeBatchConcurrently(batch.calls, executor);
      allResults.push(...batchResults);
    } else {
      // Sequential: single non-safe call or single safe call
      for (const call of batch.calls) {
        const result = await executor(call);
        allResults.push(result);
      }
    }
  }

  return allResults;
}
