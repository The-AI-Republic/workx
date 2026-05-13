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
 * Synthetic concurrency safety for web_search, which is special-cased in
 * TurnManager and not registered in ToolRegistry. Web search is a pure read
 * against an external service with no shared browser state, so it is always
 * safe to run concurrently with other safe calls.
 */
const WEB_SEARCH_CONCURRENCY_SAFE = true;

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

  const isConcurrencySafe = call.function.name === 'web_search'
    ? WEB_SEARCH_CONCURRENCY_SAFE
    : registry.isConcurrencySafe(call.function.name, parsedArguments);

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
 *
 * Contract: `executor` MUST NOT throw. Callers should wrap their per-call
 * logic in try/catch and return an error-shaped result. A throw will reject
 * `Promise.all` and abandon any in-flight workers, losing their results.
 */
export async function executeBatchConcurrently<T>(
  calls: PreparedToolCall[],
  executor: (call: PreparedToolCall) => Promise<T>,
): Promise<T[]> {
  if (calls.length === 0) {
    return [];
  }

  const results = new Array<T>(calls.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= calls.length) {
        return;
      }

      results[currentIndex] = await executor(calls[currentIndex]!);
    }
  };

  const workerCount = Math.min(MAX_SAFE_TOOL_CALL_CONCURRENCY, calls.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
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
