import { describe, it, expect } from 'vitest';
import {
  prepareToolCall,
  partitionToolCalls,
  executeBatchConcurrently,
  executeToolCallBatches,
  MAX_SAFE_TOOL_CALL_CONCURRENCY,
  type PreparedToolCall,
} from '@/core/toolOrchestration';
import { ToolRegistry } from '@/tools/ToolRegistry';

function makeTool(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `Test tool ${name}`,
      strict: false,
      parameters: { type: 'object' as const, properties: {} },
    },
  };
}

const noop = async () => ({ success: true });

function makeCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    function: { name, arguments: args },
  };
}

describe('prepareToolCall', () => {
  it('parses string arguments', () => {
    const registry = new ToolRegistry();
    const call = {
      id: 'c1',
      function: { name: 'unknown_tool', arguments: '{"key":"value"}' },
    };
    const prepared = prepareToolCall(call, registry);
    expect(prepared.parsedArguments).toEqual({ key: 'value' });
    expect(prepared.isConcurrencySafe).toBe(false); // unknown tool → fail-closed
  });

  it('handles invalid JSON gracefully', () => {
    const registry = new ToolRegistry();
    const call = {
      id: 'c1',
      function: { name: 'test', arguments: 'not json' },
    };
    const prepared = prepareToolCall(call, registry);
    expect(prepared.parsedArguments).toEqual({});
    expect(prepared.isConcurrencySafe).toBe(false);
  });

  it('classifies web_search as safe', () => {
    const registry = new ToolRegistry();
    const call = makeCall('c1', 'web_search', { query: 'test' });
    const prepared = prepareToolCall(call, registry);
    expect(prepared.isConcurrencySafe).toBe(true);
  });

  it('classifies registered safe tool as safe', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeTool('safe_tool'), noop, {
      runtime: {
        concurrency: {
          isConcurrencySafe: () => true,
          isReadOnly: () => true,
          isDestructive: () => false,
        },
      },
    });

    const call = makeCall('c1', 'safe_tool');
    const prepared = prepareToolCall(call, registry);
    expect(prepared.isConcurrencySafe).toBe(true);
  });
});

describe('partitionToolCalls', () => {
  it('merges consecutive safe calls into one batch', () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'x', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'b', name: 'y', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
    ];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[0].calls).toHaveLength(2);
  });

  it('creates singleton batch for unsafe call', () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'x', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
    ];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrencySafe).toBe(false);
    expect(batches[0].calls).toHaveLength(1);
  });

  it('partitions safe/unsafe/safe into 3 batches', () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'x', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'b', name: 'y', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'c', name: 'z', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
      { id: 'd', name: 'w', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'e', name: 'v', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
    ];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(3);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[0].calls).toHaveLength(2);
    expect(batches[1].isConcurrencySafe).toBe(false);
    expect(batches[1].calls).toHaveLength(1);
    expect(batches[2].isConcurrencySafe).toBe(true);
    expect(batches[2].calls).toHaveLength(2);
  });

  it('handles all unsafe calls', () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'x', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
      { id: 'b', name: 'y', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
    ];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(2);
    expect(batches.every(b => !b.isConcurrencySafe)).toBe(true);
  });

  it('handles empty input', () => {
    const batches = partitionToolCalls([]);
    expect(batches).toHaveLength(0);
  });
});

describe('executeBatchConcurrently', () => {
  it('executes calls and preserves order', async () => {
    const calls: PreparedToolCall[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      name: `t${i}`,
      rawArguments: {},
      parsedArguments: {},
      isConcurrencySafe: true,
    }));

    const results = await executeBatchConcurrently(calls, async (call) => call.id);
    expect(results).toEqual(['c0', 'c1', 'c2']);
  });

  it('respects MAX_SAFE_TOOL_CALL_CONCURRENCY', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const calls: PreparedToolCall[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: `t${i}`,
      rawArguments: {},
      parsedArguments: {},
      isConcurrencySafe: true,
    }));

    await executeBatchConcurrently(calls, async (call) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return call.id;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(MAX_SAFE_TOOL_CALL_CONCURRENCY);
  });

  it('avoids chunk-level head-of-line blocking by refilling slots as tasks finish', async () => {
    let current = 0;
    let maxConcurrent = 0;
    const starts: string[] = [];

    const calls: PreparedToolCall[] = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      name: `t${i}`,
      rawArguments: {},
      parsedArguments: {},
      isConcurrencySafe: true,
    }));

    const delays = [50, 50, 50, 50, 50, 5, 5];

    await executeBatchConcurrently(calls, async (call) => {
      starts.push(call.id);
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      const index = Number(call.id.slice(1));
      await new Promise(r => setTimeout(r, delays[index]));
      current--;
      return call.id;
    });

    expect(maxConcurrent).toBe(MAX_SAFE_TOOL_CALL_CONCURRENCY);
    expect(starts.slice(0, MAX_SAFE_TOOL_CALL_CONCURRENCY)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(starts[5]).toBe('c5');
  });
});

describe('executeToolCallBatches', () => {
  it('executes all batches and preserves original order', async () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'safe1', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'b', name: 'safe2', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
      { id: 'c', name: 'unsafe', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
      { id: 'd', name: 'safe3', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: true },
    ];
    const batches = partitionToolCalls(calls);

    const results = await executeToolCallBatches(batches, async (call) => call.id);
    expect(results).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles single tool call without partitioning overhead', async () => {
    const calls: PreparedToolCall[] = [
      { id: 'a', name: 'solo', rawArguments: {}, parsedArguments: {}, isConcurrencySafe: false },
    ];
    const batches = partitionToolCalls(calls);

    const results = await executeToolCallBatches(batches, async (call) => call.id);
    expect(results).toEqual(['a']);
  });
});
