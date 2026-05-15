// File: src/core/__tests__/TurnManager.parallelTools.integration.test.ts
//
// Track 11 — verifies buffered legacy `function_call` items (OpenAI
// Responses / xAI shape) run through Track 02's concurrency orchestrator:
// consecutive safe calls concurrently, unsafe sequentially, results in
// original order.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnManager } from '../TurnManager';
import { ToolRegistry } from '../../tools/ToolRegistry';

describe('TurnManager — Track 11 buffered function_call orchestration', () => {
  let session: any;
  let turnContext: any;
  let toolRegistry: ToolRegistry;
  let turnManager: TurnManager;

  beforeEach(() => {
    session = {
      getSessionId: vi.fn().mockReturnValue('test-session'),
      emitEvent: vi.fn(),
      getTabId: vi.fn().mockReturnValue(-1),
      recordTurnContext: vi.fn().mockResolvedValue(undefined),
      // no getToolResultStore → maybeEnforceTier2 is a no-op
      // no firePostTurnHooks → post-turn hook block is skipped
    };
    turnContext = {
      getToolsConfig: vi.fn().mockReturnValue({}),
      getModelClient: vi.fn(),
      getModel: vi.fn().mockReturnValue('gpt-4'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getApprovalPolicy: vi.fn().mockReturnValue('auto'),
      getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
      getEffort: vi.fn(),
      getSummary: vi.fn(),
      getSelectedModelKey: vi.fn().mockReturnValue('openai:gpt-4'),
    };
    toolRegistry = new ToolRegistry();

    // Classify: read_* safe, write_* unsafe.
    vi.spyOn(toolRegistry, 'isConcurrencySafe').mockImplementation(
      (toolName: string) => toolName.startsWith('read_'),
    );

    turnManager = new TurnManager(session, turnContext, toolRegistry);
  });

  it('runs consecutive safe calls concurrently and unsafe sequentially, preserving order', async () => {
    const events: string[] = [];

    // Spy executeToolCall: log start/end, simulate async work.
    vi.spyOn(turnManager as any, 'executeToolCall').mockImplementation(
      async (...args: unknown[]) => {
        const name = args[0] as string;
        const callId = args[2] as string;
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end:${name}`);
        return { type: 'function_call_output', call_id: callId, output: `${name}-ok` };
      },
    );

    const buffered = [
      { type: 'function_call', name: 'read_a', arguments: '{}', call_id: 'a' },
      { type: 'function_call', name: 'read_b', arguments: '{}', call_id: 'b' },
      { type: 'function_call', name: 'write_c', arguments: '{}', call_id: 'c' },
    ];

    const results = await (turnManager as any).executeBufferedToolCalls(buffered);

    // Results preserved in original order.
    expect(results.map((r: any) => r.call_id)).toEqual(['a', 'b', 'c']);
    expect(results.map((r: any) => r.output)).toEqual([
      'read_a-ok',
      'read_b-ok',
      'write_c-ok',
    ]);

    // read_a and read_b are concurrency-safe → same batch, run concurrently:
    // read_b starts before read_a ends.
    expect(events.indexOf('start:read_b')).toBeLessThan(
      events.indexOf('end:read_a'),
    );

    // write_c is unsafe → its own batch, starts only after BOTH safe calls end.
    expect(events.indexOf('start:write_c')).toBeGreaterThan(
      events.indexOf('end:read_a'),
    );
    expect(events.indexOf('start:write_c')).toBeGreaterThan(
      events.indexOf('end:read_b'),
    );
  });

  it('a single buffered call still works (default flag-off path)', async () => {
    vi.spyOn(turnManager as any, 'executeToolCall').mockImplementation(
      async (...args: unknown[]) => ({
        type: 'function_call_output',
        call_id: args[2] as string,
        output: 'single-ok',
      }),
    );

    const results = await (turnManager as any).executeBufferedToolCalls([
      { type: 'function_call', name: 'read_a', arguments: '{}', call_id: 'only' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].call_id).toBe('only');
    expect(results[0].output).toBe('single-ok');
  });

  it('stream loop: buffers function_call items, flushes at Completed, preserves position vs an interleaved non-tool item', async () => {
    // Drives the real tryRunTurn stream loop (not the helper directly), so
    // the OutputItemDone interception + Completed flush wiring is exercised.
    async function* stream() {
      yield {
        type: 'OutputItemDone',
        item: { type: 'function_call', name: 'read_a', arguments: '{}', call_id: 'a' },
      };
      // A non-tool item between the two function_calls. Its placeholder
      // position must be preserved relative to the buffered results.
      yield { type: 'OutputItemDone', item: { type: 'spacer' } };
      yield {
        type: 'OutputItemDone',
        item: { type: 'function_call', name: 'read_b', arguments: '{}', call_id: 'b' },
      };
      yield { type: 'Completed', tokenUsage: undefined };
    }

    turnContext.getModelClient.mockReturnValue({ stream: vi.fn(async () => stream()) });

    vi.spyOn(turnManager as any, 'executeToolCall').mockImplementation(
      async (...args: unknown[]) => ({
        type: 'function_call_output',
        call_id: args[2] as string,
        output: `${args[0] as string}-ok`,
      }),
    );

    const result = await (turnManager as any).tryRunTurn({ input: [], tools: [] });
    const items = result.processedItems;

    // Order locked: fc-a (0), spacer (1), fc-b (2) — buffered results did
    // not jump ahead of or behind the interleaved spacer.
    expect(items).toHaveLength(3);
    expect(items[0].item.call_id).toBe('a');
    expect(items[0].response.output).toBe('read_a-ok');
    expect(items[1].item.type).toBe('spacer');
    expect(items[1].response).toBeUndefined();
    expect(items[2].item.call_id).toBe('b');
    expect(items[2].response.output).toBe('read_b-ok');
  });

  it('stream loop: a stream that ends before Completed executes no buffered tools (all-or-nothing)', async () => {
    // Models the documented behavior change: an interrupted/incomplete
    // stream that buffered a function_call but never reached Completed runs
    // NO tools (previously the legacy path may have executed it mid-stream).
    async function* stream() {
      yield {
        type: 'OutputItemDone',
        item: { type: 'function_call', name: 'read_a', arguments: '{}', call_id: 'a' },
      };
      // No Completed — stream ends here.
    }

    turnContext.getModelClient.mockReturnValue({ stream: vi.fn(async () => stream()) });

    const execSpy = vi
      .spyOn(turnManager as any, 'executeToolCall')
      .mockResolvedValue({ type: 'function_call_output', call_id: 'a', output: 'x' });

    await expect(
      (turnManager as any).tryRunTurn({ input: [], tools: [] }),
    ).rejects.toThrow('stream closed before response.completed');

    expect(execSpy).not.toHaveBeenCalled();
  });

  it('wraps a thrown tool error in a function_call_output envelope', async () => {
    vi.spyOn(turnManager as any, 'executeToolCall').mockImplementation(
      async (...args: unknown[]) => {
        const name = args[0] as string;
        if (name === 'write_c') throw new Error('boom');
        return {
          type: 'function_call_output',
          call_id: args[2] as string,
          output: `${name}-ok`,
        };
      },
    );

    const results = await (turnManager as any).executeBufferedToolCalls([
      { type: 'function_call', name: 'read_a', arguments: '{}', call_id: 'a' },
      { type: 'function_call', name: 'write_c', arguments: '{}', call_id: 'c' },
    ]);

    expect(results[0].output).toBe('read_a-ok');
    expect(results[1].call_id).toBe('c');
    expect(results[1].output).toContain('Error: boom');
  });
});
