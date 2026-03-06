/**
 * Comprehensive unit tests for TurnManager
 *
 * Covers constructor, cancellation, error classification, retry delay calculation,
 * token usage conversion, error description/summarization, tool name extraction,
 * and missing call detection.
 *
 * These tests target private methods via (turnManager as any) to reach branches
 * that are otherwise only exercised through the full runTurn() flow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnManager } from '@/core/TurnManager';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createMocks() {
  const session = {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getTabId: vi.fn().mockReturnValue(1),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    recordTurnContext: vi.fn().mockResolvedValue(undefined),
    showRawAgentReasoning: vi.fn().mockReturnValue(false),
  } as any;

  const turnContext = {
    getToolsConfig: vi.fn().mockReturnValue({ enable_all_tools: false }),
    getModelClient: vi.fn().mockReturnValue({ stream: vi.fn() }),
    getCwd: vi.fn().mockReturnValue('/test'),
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getApprovalPolicy: vi.fn().mockReturnValue('auto'),
    getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
    getModel: vi.fn().mockReturnValue('gpt-4'),
    getEffort: vi.fn().mockReturnValue(undefined),
    getSummary: vi.fn().mockReturnValue({ enabled: false }),
    getBaseInstructions: vi.fn().mockReturnValue(undefined),
    getUserInstructions: vi.fn().mockReturnValue(undefined),
  } as any;

  const toolRegistry = {
    getTool: vi.fn().mockReturnValue(undefined),
    execute: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  } as any;

  return { session, turnContext, toolRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnManager - constructor and initial state', () => {
  it('should initialize with cancelled=false', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);
    expect(tm.isCancelled()).toBe(false);
  });

  it('should apply default config when none is provided', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);
    // Access private config via any-cast
    const config = (tm as any).config;
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelayMs).toBe(1000);
    expect(config.maxRetryDelayMs).toBe(30000);
  });

  it('should merge custom config over defaults', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 5,
      retryDelayMs: 2000,
    });
    const config = (tm as any).config;
    expect(config.maxRetries).toBe(5);
    expect(config.retryDelayMs).toBe(2000);
    expect(config.maxRetryDelayMs).toBe(30000); // default preserved
  });

  it('should store session, turnContext, and toolRegistry references', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);
    expect((tm as any).session).toBe(session);
    expect((tm as any).turnContext).toBe(turnContext);
    expect((tm as any).toolRegistry).toBe(toolRegistry);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - cancel / isCancelled', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should return false before cancel is called', () => {
    expect(tm.isCancelled()).toBe(false);
  });

  it('should return true after cancel is called', () => {
    tm.cancel();
    expect(tm.isCancelled()).toBe(true);
  });

  it('should remain true after multiple cancel calls', () => {
    tm.cancel();
    tm.cancel();
    expect(tm.isCancelled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - isNonRetryableError', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should treat "interrupted" as non-retryable', () => {
    const error = new Error('The request was interrupted by the user');
    expect((tm as any).isNonRetryableError(error)).toBe(true);
  });

  it('should treat "cancelled" as non-retryable', () => {
    const error = new Error('Request cancelled');
    expect((tm as any).isNonRetryableError(error)).toBe(true);
  });

  it('should treat "usage limit" as non-retryable', () => {
    const error = new Error('You have exceeded your usage limit');
    expect((tm as any).isNonRetryableError(error)).toBe(true);
  });

  it('should treat "unauthorized" as non-retryable', () => {
    const error = new Error('Unauthorized access');
    expect((tm as any).isNonRetryableError(error)).toBe(true);
  });

  it('should treat AuthenticationError by name as non-retryable', () => {
    const error = new Error('bad token');
    error.name = 'AuthenticationError';
    expect((tm as any).isNonRetryableError(error)).toBe(true);
  });

  it('should treat generic network errors as retryable', () => {
    const error = new Error('ECONNRESET');
    expect((tm as any).isNonRetryableError(error)).toBe(false);
  });

  it('should treat timeout errors as retryable', () => {
    const error = new Error('Request timeout');
    expect((tm as any).isNonRetryableError(error)).toBe(false);
  });

  it('should treat rate limit errors as retryable', () => {
    const error = new Error('Rate limit exceeded');
    expect((tm as any).isNonRetryableError(error)).toBe(false);
  });

  it('should handle errors without a message gracefully', () => {
    const error = { name: 'SomeError' };
    expect((tm as any).isNonRetryableError(error)).toBe(false);
  });

  it('should handle errors with undefined message', () => {
    const error = { message: undefined };
    expect((tm as any).isNonRetryableError(error)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - calculateRetryDelay', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry, {
      retryDelayMs: 1000,
      maxRetryDelayMs: 30000,
    });
  });

  it('should return base delay for first attempt', () => {
    const delay = (tm as any).calculateRetryDelay(1, {});
    // 1000 * 2^0 = 1000
    expect(delay).toBe(1000);
  });

  it('should double delay for second attempt', () => {
    const delay = (tm as any).calculateRetryDelay(2, {});
    // 1000 * 2^1 = 2000
    expect(delay).toBe(2000);
  });

  it('should quadruple delay for third attempt', () => {
    const delay = (tm as any).calculateRetryDelay(3, {});
    // 1000 * 2^2 = 4000
    expect(delay).toBe(4000);
  });

  it('should cap delay at maxRetryDelayMs', () => {
    const delay = (tm as any).calculateRetryDelay(20, {});
    // 1000 * 2^19 would be huge, but capped at 30000
    expect(delay).toBe(30000);
  });

  it('should respect error.retryAfter when present (seconds to ms)', () => {
    const error = { retryAfter: 5 };
    const delay = (tm as any).calculateRetryDelay(1, error);
    // 5 * 1000 = 5000
    expect(delay).toBe(5000);
  });

  it('should cap retryAfter at maxRetryDelayMs', () => {
    const error = { retryAfter: 60 }; // 60 seconds = 60000ms, but max is 30000
    const delay = (tm as any).calculateRetryDelay(1, error);
    expect(delay).toBe(30000);
  });

  it('should use custom config values', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const customTm = new TurnManager(session, turnContext, toolRegistry, {
      retryDelayMs: 500,
      maxRetryDelayMs: 10000,
    });
    const delay = (customTm as any).calculateRetryDelay(2, {});
    // 500 * 2^1 = 1000
    expect(delay).toBe(1000);
  });

  it('should cap at custom maxRetryDelayMs', () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const customTm = new TurnManager(session, turnContext, toolRegistry, {
      retryDelayMs: 500,
      maxRetryDelayMs: 2000,
    });
    const delay = (customTm as any).calculateRetryDelay(10, {});
    expect(delay).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - convertTokenUsage', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should convert a fully populated usage object', () => {
    const usage = {
      prompt_tokens: 100,
      cached_tokens: 20,
      completion_tokens: 50,
      reasoning_tokens: 10,
      total_tokens: 180,
    };
    const result = (tm as any).convertTokenUsage(usage);
    expect(result).toEqual({
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50,
      reasoning_output_tokens: 10,
      total_tokens: 180,
    });
  });

  it('should default missing fields to 0', () => {
    const usage = {};
    const result = (tm as any).convertTokenUsage(usage);
    expect(result).toEqual({
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    });
  });

  it('should handle partial usage (only prompt_tokens)', () => {
    const usage = { prompt_tokens: 42 };
    const result = (tm as any).convertTokenUsage(usage);
    expect(result.input_tokens).toBe(42);
    expect(result.cached_input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.reasoning_output_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
  });

  it('should handle zero values without falling to default', () => {
    const usage = {
      prompt_tokens: 0,
      cached_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
    };
    const result = (tm as any).convertTokenUsage(usage);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - describeError', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should describe a plain Error', () => {
    const error = new Error('something went wrong');
    const desc = (tm as any).describeError(error);
    expect(desc).toBe('something went wrong');
  });

  it('should include custom error name', () => {
    const error = new Error('bad input');
    error.name = 'ValidationError';
    const desc = (tm as any).describeError(error);
    expect(desc).toBe('ValidationError: bad input');
  });

  it('should handle Error with default name "Error"', () => {
    const error = new Error('oops');
    // error.name defaults to "Error"
    const desc = (tm as any).describeError(error);
    // name === "Error" is suppressed
    expect(desc).toBe('oops');
  });

  it('should handle Error with empty message', () => {
    const error = new Error('');
    const desc = (tm as any).describeError(error);
    expect(desc).toBe('(no message)');
  });

  it('should return string values as-is', () => {
    const desc = (tm as any).describeError('raw string error');
    expect(desc).toBe('raw string error');
  });

  it('should JSON.stringify plain objects', () => {
    const obj = { code: 500, message: 'server error' };
    const desc = (tm as any).describeError(obj);
    expect(desc).toBe(JSON.stringify(obj));
  });

  it('should return "[object Object]" for non-serializable objects', () => {
    // Create a circular reference that cannot be JSON.stringified
    const circular: any = {};
    circular.self = circular;
    const desc = (tm as any).describeError(circular);
    expect(desc).toBe('[object Object]');
  });

  it('should return "Unknown stream error" for null', () => {
    const desc = (tm as any).describeError(null);
    expect(desc).toBe('Unknown stream error');
  });

  it('should return "Unknown stream error" for undefined', () => {
    const desc = (tm as any).describeError(undefined);
    expect(desc).toBe('Unknown stream error');
  });

  it('should return "Unknown stream error" for numbers', () => {
    const desc = (tm as any).describeError(42);
    expect(desc).toBe('Unknown stream error');
  });

  it('should return "Unknown stream error" for booleans', () => {
    const desc = (tm as any).describeError(true);
    expect(desc).toBe('Unknown stream error');
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - getErrorCause', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should return cause from an Error with cause', () => {
    const inner = new Error('root cause');
    const outer = new Error('wrapper');
    (outer as any).cause = inner;
    const cause = (tm as any).getErrorCause(outer);
    expect(cause).toBe(inner);
  });

  it('should return undefined when Error has no cause', () => {
    const error = new Error('no cause');
    const cause = (tm as any).getErrorCause(error);
    expect(cause).toBeUndefined();
  });

  it('should return cause from a plain object with cause property', () => {
    const obj = { message: 'wrapper', cause: { message: 'inner' } };
    const cause = (tm as any).getErrorCause(obj);
    expect(cause).toEqual({ message: 'inner' });
  });

  it('should return undefined for a plain object without cause', () => {
    const obj = { message: 'no cause here' };
    const cause = (tm as any).getErrorCause(obj);
    expect(cause).toBeUndefined();
  });

  it('should return undefined for null', () => {
    const cause = (tm as any).getErrorCause(null);
    expect(cause).toBeUndefined();
  });

  it('should return undefined for a string', () => {
    const cause = (tm as any).getErrorCause('just a string');
    expect(cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - extractStreamErrorSummary', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should return string errors directly', () => {
    const summary = (tm as any).extractStreamErrorSummary('connection refused');
    expect(summary).toBe('connection refused');
  });

  it('should return "Unknown stream error" for null and undefined', () => {
    expect((tm as any).extractStreamErrorSummary(null)).toBe('Unknown stream error');
    expect((tm as any).extractStreamErrorSummary(undefined)).toBe('Unknown stream error');
    expect((tm as any).extractStreamErrorSummary(0)).toBe('Unknown stream error');
  });

  it('should return empty string as-is (string passthrough)', () => {
    // Empty string is typeof 'string', so it is returned directly
    expect((tm as any).extractStreamErrorSummary('')).toBe('');
  });

  it('should describe a simple Error', () => {
    const error = new Error('stream timeout');
    const summary = (tm as any).extractStreamErrorSummary(error);
    expect(summary).toBe('stream timeout');
  });

  it('should traverse cause chain and return deepest description', () => {
    const root = new Error('root cause');
    const middle = new Error('middle');
    (middle as any).cause = root;
    const outer = new Error('outer');
    (outer as any).cause = middle;
    const summary = (tm as any).extractStreamErrorSummary(outer);
    expect(summary).toBe('root cause');
  });

  it('should handle Error with named custom error type', () => {
    const error = new Error('rate limited');
    error.name = 'APIError';
    const summary = (tm as any).extractStreamErrorSummary(error);
    expect(summary).toBe('APIError: rate limited');
  });

  it('should handle plain object errors', () => {
    const error = { code: 503, message: 'service unavailable' };
    const summary = (tm as any).extractStreamErrorSummary(error);
    expect(summary).toBe(JSON.stringify(error));
  });

  it('should not loop infinitely on circular cause chains', () => {
    const a = new Error('a');
    const b = new Error('b');
    (b as any).cause = a;
    // Manually create a circular cause chain
    (a as any).cause = b;
    // Should terminate and return a description (not hang)
    const summary = (tm as any).extractStreamErrorSummary(a);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - getToolNameFromDefinition', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should extract name from function type tool', () => {
    const tool = {
      type: 'function',
      function: { name: 'click_element', description: 'Click an element' },
    };
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('click_element');
  });

  it('should extract name from custom type tool', () => {
    const tool = {
      type: 'custom',
      custom: { name: 'my_custom_tool', description: 'Custom tool' },
    };
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('my_custom_tool');
  });

  it('should return "local_shell" for local_shell type', () => {
    const tool = { type: 'local_shell' };
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('local_shell');
  });

  it('should return "web_search" for web_search type', () => {
    const tool = { type: 'web_search' };
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('web_search');
  });

  it('should return "unknown_tool" for unrecognized type', () => {
    const tool = { type: 'something_else' };
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('unknown_tool');
  });

  it('should return "unknown_tool" for tool with no type', () => {
    const tool = {};
    expect((tm as any).getToolNameFromDefinition(tool)).toBe('unknown_tool');
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - processMissingCalls', () => {
  let tm: TurnManager;

  beforeEach(() => {
    const { session, turnContext, toolRegistry } = createMocks();
    tm = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should return prompt unchanged when no missing calls', () => {
    const prompt = {
      input: [
        { type: 'function_call', call_id: 'call-1' },
        { type: 'function_call_output', call_id: 'call-1', output: 'done' },
      ],
      tools: [],
    };
    const result = (tm as any).processMissingCalls(prompt);
    expect(result).toBe(prompt); // Same reference -- no modifications
  });

  it('should add synthetic aborted response for missing call', () => {
    const prompt = {
      input: [
        { type: 'function_call', call_id: 'call-1' },
        { type: 'function_call', call_id: 'call-2' },
        { type: 'function_call_output', call_id: 'call-1', output: 'done' },
        // call-2 has no output -> missing
      ],
      tools: [],
    };
    const result = (tm as any).processMissingCalls(prompt);

    // Synthetic response should be prepended
    const syntheticItems = result.input.filter(
      (item: any) => item.output === 'aborted'
    );
    expect(syntheticItems).toHaveLength(1);
    expect(syntheticItems[0].call_id).toBe('call-2');
    expect(syntheticItems[0].type).toBe('function_call_output');
  });

  it('should add multiple synthetic responses for multiple missing calls', () => {
    const prompt = {
      input: [
        { type: 'function_call', call_id: 'call-a' },
        { type: 'function_call', call_id: 'call-b' },
        { type: 'function_call', call_id: 'call-c' },
        // No outputs at all
      ],
      tools: [],
    };
    const result = (tm as any).processMissingCalls(prompt);
    const syntheticItems = result.input.filter(
      (item: any) => item.output === 'aborted'
    );
    expect(syntheticItems).toHaveLength(3);
    const abortedIds = syntheticItems.map((item: any) => item.call_id);
    expect(abortedIds).toContain('call-a');
    expect(abortedIds).toContain('call-b');
    expect(abortedIds).toContain('call-c');
  });

  it('should return prompt unchanged when input is empty', () => {
    const prompt = { input: [], tools: [] };
    const result = (tm as any).processMissingCalls(prompt);
    expect(result).toBe(prompt);
  });

  it('should ignore items without call_id', () => {
    const prompt = {
      input: [
        { type: 'function_call' }, // no call_id
        { type: 'message', role: 'user', content: 'hello' },
      ],
      tools: [],
    };
    const result = (tm as any).processMissingCalls(prompt);
    // No missing calls detected (items without call_id are not tracked)
    expect(result).toBe(prompt);
  });

  it('should preserve other prompt fields', () => {
    const prompt = {
      input: [
        { type: 'function_call', call_id: 'call-1' },
        // missing output
      ],
      tools: [{ type: 'function', function: { name: 'test' } }],
      base_instructions_override: 'custom instructions',
    };
    const result = (tm as any).processMissingCalls(prompt);
    expect(result.tools).toEqual(prompt.tools);
    expect(result.base_instructions_override).toBe('custom instructions');
  });

  it('should prepend synthetic responses before existing input items', () => {
    const prompt = {
      input: [
        { type: 'function_call', call_id: 'call-1' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
      tools: [],
    };
    const result = (tm as any).processMissingCalls(prompt);
    // First item should be the synthetic aborted response
    expect(result.input[0].type).toBe('function_call_output');
    expect(result.input[0].output).toBe('aborted');
    expect(result.input[0].call_id).toBe('call-1');
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - emitStreamError', () => {
  it('should emit a StreamError event with all fields', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);

    await (tm as any).emitStreamError('test error', true, 2, 5000, 3);

    expect(session.emitEvent).toHaveBeenCalledTimes(1);
    const emittedEvent = session.emitEvent.mock.calls[0][0];
    expect(emittedEvent.msg.type).toBe('StreamError');
    expect(emittedEvent.msg.data.error).toBe('test error');
    expect(emittedEvent.msg.data.retrying).toBe(true);
    expect(emittedEvent.msg.data.attempt).toBe(2);
    expect(emittedEvent.msg.data.delayMs).toBe(5000);
    expect(emittedEvent.msg.data.maxRetries).toBe(3);
  });

  it('should omit optional fields when not provided', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);

    await (tm as any).emitStreamError('error only', false);

    const emittedEvent = session.emitEvent.mock.calls[0][0];
    expect(emittedEvent.msg.data.error).toBe('error only');
    expect(emittedEvent.msg.data.retrying).toBe(false);
    expect(emittedEvent.msg.data.attempt).toBeUndefined();
    expect(emittedEvent.msg.data.delayMs).toBeUndefined();
    expect(emittedEvent.msg.data.maxRetries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - emitEvent', () => {
  it('should emit event through session with a UUID id', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const msg = { type: 'AgentMessageDelta', data: { delta: 'hello' } };
    await (tm as any).emitEvent(msg);

    expect(session.emitEvent).toHaveBeenCalledTimes(1);
    const emittedEvent = session.emitEvent.mock.calls[0][0];
    expect(emittedEvent.id).toBeDefined();
    expect(typeof emittedEvent.id).toBe('string');
    expect(emittedEvent.id.length).toBeGreaterThan(0);
    expect(emittedEvent.msg).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - sleep', () => {
  it('should resolve after specified delay', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);

    vi.useFakeTimers();

    const sleepPromise = (tm as any).sleep(1000);
    vi.advanceTimersByTime(1000);
    await sleepPromise;

    // If we get here, the promise resolved successfully
    expect(true).toBe(true);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - runTurn cancellation', () => {
  it('should throw "Turn cancelled" if already cancelled before runTurn', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const tm = new TurnManager(session, turnContext, toolRegistry);
    tm.cancel();

    await expect(tm.runTurn([])).rejects.toThrow('Turn cancelled');
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - runTurn retry logic', () => {
  it('should retry on retryable errors up to maxRetries', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const streamError = new Error('ECONNRESET');

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        throw streamError;
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 2,
      retryDelayMs: 1, // Very fast retries for testing
      maxRetryDelayMs: 10,
    });

    // Override sleep to avoid actual delays
    (tm as any).sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tm.runTurn([])).rejects.toThrow();

    // Should have called stream 3 times total (1 initial + 2 retries)
    expect(mockModelClient.stream).toHaveBeenCalledTimes(3);
  });

  it('should not retry non-retryable errors', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const authError = new Error('Unauthorized access');

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        throw authError;
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 3,
      retryDelayMs: 1,
    });

    (tm as any).sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tm.runTurn([])).rejects.toThrow('Unauthorized access');

    // Should only call stream once -- no retries for non-retryable errors
    expect(mockModelClient.stream).toHaveBeenCalledTimes(1);
  });

  it('should emit StreamError events during retries', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const retryableError = new Error('connection lost');

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        throw retryableError;
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 1,
      retryDelayMs: 1,
      maxRetryDelayMs: 10,
    });

    (tm as any).sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tm.runTurn([])).rejects.toThrow();

    // Verify at least one StreamError event was emitted
    const streamErrorCalls = session.emitEvent.mock.calls.filter(
      (call: any) => call[0].msg.type === 'StreamError'
    );
    expect(streamErrorCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - tryRunTurn stream processing', () => {
  it('should throw when stream yields null event', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield null;
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    // Note: maxRetries: 0 is falsy, so `this.config.maxRetries || 3` becomes 3.
    // We use maxRetries: 1 and mock sleep to keep the test fast.
    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 1,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    (tm as any).sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tm.runTurn([])).rejects.toThrow();
  });

  it('should return result on Completed event', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const tokenUsage = {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      total_tokens: 30,
    };

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'Created' };
        yield {
          type: 'Completed',
          tokenUsage,
        };
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    const tm = new TurnManager(session, turnContext, toolRegistry);

    const result = await tm.runTurn([]);
    expect(result.processedItems).toEqual([]);
    expect(result.totalTokenUsage).toEqual(tokenUsage);
  });

  it('should throw when stream ends without Completed event', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'Created' };
        // Stream ends here without Completed
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    // maxRetries: 1 with mocked sleep to avoid real delays
    const tm = new TurnManager(session, turnContext, toolRegistry, {
      maxRetries: 1,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    (tm as any).sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tm.runTurn([])).rejects.toThrow();
  });

  it('should emit AgentMessageDelta for OutputTextDelta events', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    turnContext.getToolsConfig.mockReturnValue({ enable_all_tools: false });
    toolRegistry.listTools.mockReturnValue([]);

    const tokenUsage = {
      input_tokens: 5,
      cached_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 15,
    };

    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'OutputTextDelta', delta: 'Hello' };
        yield { type: 'OutputTextDelta', delta: ' world' };
        yield { type: 'Completed', tokenUsage };
      },
    };

    const mockModelClient = {
      stream: vi.fn().mockResolvedValue(mockStream),
    };
    turnContext.getModelClient.mockReturnValue(mockModelClient);

    const tm = new TurnManager(session, turnContext, toolRegistry);

    await tm.runTurn([]);

    const deltaCalls = session.emitEvent.mock.calls.filter(
      (call: any) => call[0].msg.type === 'AgentMessageDelta'
    );
    expect(deltaCalls).toHaveLength(2);
    expect(deltaCalls[0][0].msg.data.delta).toBe('Hello');
    expect(deltaCalls[1][0].msg.data.delta).toBe(' world');
  });
});

// ---------------------------------------------------------------------------
describe('TurnManager - useNativeWebSearch toggle', () => {
  function createWebSearchMocks(toolsConfig: any, supportsNative: boolean) {
    const session = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getTabId: vi.fn().mockReturnValue(1),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      recordTurnContext: vi.fn().mockResolvedValue(undefined),
      showRawAgentReasoning: vi.fn().mockReturnValue(false),
    } as any;

    const mockModelClient = {
      stream: vi.fn(),
      supportsNativeWebSearch: vi.fn().mockReturnValue(supportsNative),
    };

    const turnContext = {
      getToolsConfig: vi.fn().mockReturnValue(toolsConfig),
      getModelClient: vi.fn().mockReturnValue(mockModelClient),
      getCwd: vi.fn().mockReturnValue('/test'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getApprovalPolicy: vi.fn().mockReturnValue('auto'),
      getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
      getModel: vi.fn().mockReturnValue('gpt-4'),
      getEffort: vi.fn().mockReturnValue(undefined),
      getSummary: vi.fn().mockReturnValue({ enabled: false }),
      getBaseInstructions: vi.fn().mockReturnValue(undefined),
      getUserInstructions: vi.fn().mockReturnValue(undefined),
      getSelectedModelKey: vi.fn().mockReturnValue('openai:gpt-4'),
    } as any;

    const toolRegistry = {
      getTool: vi.fn().mockReturnValue(undefined),
      execute: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    } as any;

    return { session, turnContext, toolRegistry, mockModelClient };
  }

  it('should use native web search when useNativeWebSearch is true and model supports it', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: true, useNativeWebSearch: true },
      true
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) => t.type === 'web_search' || (t.type === 'function' && t.function?.name === 'web_search'));

    expect(webSearchTool).toBeDefined();
    expect(webSearchTool.type).toBe('web_search');
    expect((tm as any).nativeWebSearchEnabled).toBe(true);
  });

  it('should use native web search by default (useNativeWebSearch undefined) when model supports it', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: true },
      true
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) => t.type === 'web_search');

    expect(webSearchTool).toBeDefined();
    expect((tm as any).nativeWebSearchEnabled).toBe(true);
  });

  it('should fall back to CDP when useNativeWebSearch is false even if model supports native', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: true, useNativeWebSearch: false },
      true
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) => t.type === 'function' && t.function?.name === 'web_search');

    expect(webSearchTool).toBeDefined();
    expect(webSearchTool.type).toBe('function');
    expect(webSearchTool.function.name).toBe('web_search');
    expect((tm as any).nativeWebSearchEnabled).toBe(false);
  });

  it('should fall back to CDP when useNativeWebSearch is true but model does not support native', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: true, useNativeWebSearch: true },
      false
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) => t.type === 'function' && t.function?.name === 'web_search');

    expect(webSearchTool).toBeDefined();
    expect(webSearchTool.type).toBe('function');
    expect((tm as any).nativeWebSearchEnabled).toBe(false);
  });

  it('should fall back to CDP when useNativeWebSearch is undefined and model does not support native', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: true },
      false
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) => t.type === 'function' && t.function?.name === 'web_search');

    expect(webSearchTool).toBeDefined();
    expect(webSearchTool.type).toBe('function');
    expect((tm as any).nativeWebSearchEnabled).toBe(false);
  });

  it('should not add any web search tool when webSearch is disabled', async () => {
    const { session, turnContext, toolRegistry } = createWebSearchMocks(
      { webSearch: false, useNativeWebSearch: true },
      true
    );
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();
    const webSearchTool = tools.find((t: any) =>
      t.type === 'web_search' || (t.type === 'function' && t.function?.name === 'web_search')
    );

    expect(webSearchTool).toBeUndefined();
  });
});
