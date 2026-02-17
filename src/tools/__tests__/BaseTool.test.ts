/**
 * Unit tests for BaseTool
 *
 * Since BaseTool is abstract, we create a concrete TestTool subclass that
 * exposes its protected methods for direct testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BaseTool,
  type ToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
  type ToolError,
  type JsonSchema,
  createFunctionTool,
  createObjectSchema,
  createToolDefinition,
} from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Concrete subclass that exposes protected members for testing
// ---------------------------------------------------------------------------

/**
 * Minimal function-type tool definition used by most tests.
 */
function makeFunctionDefinition(overrides?: {
  name?: string;
  description?: string;
  parameters?: JsonSchema;
  strict?: boolean;
  additionalProperties?: boolean;
}): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: overrides?.name ?? 'test_tool',
      description: overrides?.description ?? 'A tool used for testing',
      strict: overrides?.strict ?? false,
      parameters: overrides?.parameters ?? {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL' },
          count: { type: 'integer', description: 'Number of items' },
          verbose: { type: 'boolean', description: 'Verbose output' },
          score: { type: 'number', description: 'A floating point score' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of tags',
          },
          options: {
            type: 'object',
            properties: {
              mode: { type: 'string', description: 'Operating mode' },
            },
            description: 'Nested options',
          },
        },
        required: ['url'],
        additionalProperties: overrides?.additionalProperties ?? false,
      },
    },
  };
}

class TestTool extends BaseTool {
  protected toolDefinition: ToolDefinition;

  /** What executeImpl will do when called */
  public implBehaviour: 'resolve' | 'reject' = 'resolve';
  public implReturnValue: any = { ok: true };
  public implError: Error = new Error('boom');
  public lastRequest: BaseToolRequest | null = null;

  constructor(definition?: ToolDefinition) {
    super();
    this.toolDefinition = definition ?? makeFunctionDefinition();
  }

  protected async executeImpl(
    request: BaseToolRequest,
    _options?: BaseToolOptions,
  ): Promise<any> {
    this.lastRequest = request;
    if (this.implBehaviour === 'reject') {
      throw this.implError;
    }
    return this.implReturnValue;
  }

  // --- Expose protected helpers for unit testing ---

  public callValidateParameters(params: Record<string, any>) {
    return this.validateParameters(params);
  }

  public callApplyDefaults(params: Record<string, any>) {
    return this.applyDefaults(params);
  }

  public callFormatError(error: Error | string) {
    return this.formatError(error);
  }

  public callCreateError(code: string, message: string, details?: any): ToolError {
    return this.createError(code, message, details);
  }

  public callExecuteWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries?: number,
    delayMs?: number,
  ) {
    return this.executeWithRetry(operation, maxRetries, delayMs);
  }

  public callExecuteWithTimeout<T>(operation: () => Promise<T>, timeoutMs?: number) {
    return this.executeWithTimeout(operation, timeoutMs);
  }

  public callValidateChromeContext() {
    return this.validateChromeContext();
  }

  public callValidateTabId(tabId: number) {
    return this.validateTabId(tabId);
  }

  public callGetActiveTab() {
    return this.getActiveTab();
  }

  public callLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any) {
    return this.log(level, message, data);
  }

  public callCreateContext(sessionId: string, turnId: string) {
    return this.createContext(sessionId, turnId);
  }

  public callSafeStringify(obj: any, maxDepth?: number) {
    return this.safeStringify(obj, maxDepth);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BaseTool', () => {
  let tool: TestTool;

  beforeEach(() => {
    tool = new TestTool();
  });

  // =========================================================================
  // getDefinition()
  // =========================================================================

  describe('getDefinition()', () => {
    it('should return the tool definition', () => {
      const def = tool.getDefinition();
      expect(def).toBeDefined();
      expect(def.type).toBe('function');
    });

    it('should return the exact definition object set on the instance', () => {
      const custom = makeFunctionDefinition({ name: 'custom_tool' });
      const customTool = new TestTool(custom);
      const def = customTool.getDefinition();

      expect(def).toBe(custom); // reference equality
      if (def.type === 'function') {
        expect(def.function.name).toBe('custom_tool');
      }
    });

    it('should return non-function definitions unchanged', () => {
      const shellDef: ToolDefinition = { type: 'local_shell' };
      const shellTool = new TestTool(shellDef);
      expect(shellTool.getDefinition()).toBe(shellDef);
      expect(shellTool.getDefinition().type).toBe('local_shell');
    });
  });

  // =========================================================================
  // execute()
  // =========================================================================

  describe('execute()', () => {
    it('should return success result when executeImpl succeeds', async () => {
      tool.implReturnValue = { page: 'loaded' };
      const result = await tool.execute({ url: 'https://example.com' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ page: 'loaded' });
      expect(result.error).toBeUndefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.toolName).toBe('test_tool');
      expect(typeof result.metadata!.duration).toBe('number');
    });

    it('should pass processed request to executeImpl after applying defaults', async () => {
      await tool.execute({ url: 'https://example.com' });

      // applyDefaults creates a shallow copy
      expect(tool.lastRequest).toEqual({ url: 'https://example.com' });
      expect(tool.lastRequest).not.toBe({ url: 'https://example.com' }); // different ref
    });

    it('should merge options.metadata into result metadata on success', async () => {
      const result = await tool.execute(
        { url: 'https://example.com' },
        { metadata: { sessionId: 'sess_1', custom: 42 } },
      );

      expect(result.success).toBe(true);
      expect(result.metadata!.sessionId).toBe('sess_1');
      expect(result.metadata!.custom).toBe(42);
    });

    it('should return failure result when validation fails (missing required param)', async () => {
      const result = await tool.execute({}); // 'url' is required

      expect(result.success).toBe(false);
      expect(result.error).toContain('Parameter validation failed');
      expect(result.error).toContain("Required parameter 'url' is missing");
      expect(result.metadata!.validationErrors).toBeDefined();
      expect(result.metadata!.validationErrors.length).toBeGreaterThan(0);
    });

    it('should return failure result when executeImpl throws', async () => {
      tool.implBehaviour = 'reject';
      tool.implError = new TypeError('Network failure');

      const result = await tool.execute({ url: 'https://example.com' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('TypeError: Network failure');
      expect(result.metadata!.toolName).toBe('test_tool');
      expect(result.metadata!.errorType).toBe('TypeError');
    });

    it('should merge options.metadata into result metadata on failure', async () => {
      tool.implBehaviour = 'reject';
      const result = await tool.execute(
        { url: 'https://example.com' },
        { metadata: { requestId: 'r_1' } },
      );

      expect(result.success).toBe(false);
      expect(result.metadata!.requestId).toBe('r_1');
    });

    it('should use tool type as name for non-function definitions', async () => {
      const shellTool = new TestTool({ type: 'local_shell' } as ToolDefinition);
      const result = await shellTool.execute({});

      expect(result.success).toBe(true);
      expect(result.metadata!.toolName).toBe('local_shell');
    });

    it('should report duration in metadata', async () => {
      const result = await tool.execute({ url: 'https://example.com' });

      expect(result.metadata!.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // validateParameters()
  // =========================================================================

  describe('validateParameters()', () => {
    // --- Required fields ---

    it('should pass when all required parameters are present', () => {
      const result = tool.callValidateParameters({ url: 'https://example.com' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when a required parameter is missing', () => {
      const result = tool.callValidateParameters({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'url', code: 'REQUIRED' }),
      );
    });

    it('should fail when a required parameter is null', () => {
      const result = tool.callValidateParameters({ url: null });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'url', code: 'REQUIRED' }),
      );
    });

    it('should fail when a required parameter is undefined', () => {
      const result = tool.callValidateParameters({ url: undefined });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'url', code: 'REQUIRED' }),
      );
    });

    // --- Type checking ---

    it('should validate string type', () => {
      const good = tool.callValidateParameters({ url: 'https://example.com' });
      expect(good.valid).toBe(true);

      const bad = tool.callValidateParameters({ url: 123 });
      expect(bad.valid).toBe(false);
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ parameter: 'url', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate integer type', () => {
      const good = tool.callValidateParameters({ url: 'x', count: 5 });
      expect(good.valid).toBe(true);

      const badFloat = tool.callValidateParameters({ url: 'x', count: 3.14 });
      expect(badFloat.valid).toBe(false);
      expect(badFloat.errors).toContainEqual(
        expect.objectContaining({ parameter: 'count', code: 'TYPE_MISMATCH' }),
      );

      const badStr = tool.callValidateParameters({ url: 'x', count: 'five' });
      expect(badStr.valid).toBe(false);
    });

    it('should validate boolean type', () => {
      const good = tool.callValidateParameters({ url: 'x', verbose: true });
      expect(good.valid).toBe(true);

      const bad = tool.callValidateParameters({ url: 'x', verbose: 'yes' });
      expect(bad.valid).toBe(false);
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ parameter: 'verbose', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate number type', () => {
      const good = tool.callValidateParameters({ url: 'x', score: 9.5 });
      expect(good.valid).toBe(true);

      const bad = tool.callValidateParameters({ url: 'x', score: 'high' });
      expect(bad.valid).toBe(false);
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ parameter: 'score', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should reject NaN as a number', () => {
      const result = tool.callValidateParameters({ url: 'x', score: NaN });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'score', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate array type', () => {
      const good = tool.callValidateParameters({ url: 'x', tags: ['a', 'b'] });
      expect(good.valid).toBe(true);

      const bad = tool.callValidateParameters({ url: 'x', tags: 'not-an-array' });
      expect(bad.valid).toBe(false);
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ parameter: 'tags', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate items inside arrays', () => {
      const result = tool.callValidateParameters({ url: 'x', tags: ['good', 42] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'tags[1]', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate object type', () => {
      const good = tool.callValidateParameters({
        url: 'x',
        options: { mode: 'fast' },
      });
      expect(good.valid).toBe(true);

      const bad = tool.callValidateParameters({ url: 'x', options: 'not-an-object' });
      expect(bad.valid).toBe(false);
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ parameter: 'options', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should reject an array when object is expected', () => {
      const result = tool.callValidateParameters({ url: 'x', options: [1, 2] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'options', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should validate nested object properties', () => {
      const result = tool.callValidateParameters({
        url: 'x',
        options: { mode: 123 },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'options.mode', code: 'TYPE_MISMATCH' }),
      );
    });

    it('should report null value for provided-but-null optional parameters', () => {
      const result = tool.callValidateParameters({ url: 'x', verbose: null });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ parameter: 'verbose', code: 'NULL_VALUE' }),
      );
    });

    // --- Unknown parameters ---

    it('should reject unknown parameters when additionalProperties is false', () => {
      const result = tool.callValidateParameters({
        url: 'x',
        unknownParam: 'surprise',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          parameter: 'unknownParam',
          code: 'UNKNOWN_PARAMETER',
        }),
      );
    });

    it('should allow unknown parameters when additionalProperties is true', () => {
      const permissiveTool = new TestTool(
        makeFunctionDefinition({ additionalProperties: true }),
      );
      const result = permissiveTool.callValidateParameters({
        url: 'x',
        extraStuff: 'allowed',
      });
      expect(result.valid).toBe(true);
    });

    // --- Non-function definitions ---

    it('should pass validation for non-function tool types (no parameters to validate)', () => {
      const shellTool = new TestTool({ type: 'local_shell' } as ToolDefinition);
      const result = shellTool.callValidateParameters({ anything: 'goes' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass validation for web_search tool type', () => {
      const searchTool = new TestTool({ type: 'web_search' } as ToolDefinition);
      const result = searchTool.callValidateParameters({});
      expect(result.valid).toBe(true);
    });

    // --- Non-object schema ---

    it('should pass validation when parameters schema type is not object', () => {
      const def = makeFunctionDefinition({
        parameters: { type: 'string', description: 'raw input' },
      });
      const stringTool = new TestTool(def);
      const result = stringTool.callValidateParameters({ whatever: true });
      expect(result.valid).toBe(true);
    });

    // --- Multiple errors ---

    it('should accumulate multiple validation errors', () => {
      const result = tool.callValidateParameters({
        count: 'not-a-number',
        verbose: 42,
        extra: true,
      });
      // Missing required 'url', wrong type for 'count', wrong type for 'verbose', unknown 'extra'
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // applyDefaults()
  // =========================================================================

  describe('applyDefaults()', () => {
    it('should return a shallow copy of the parameters', () => {
      const original = { url: 'https://example.com', count: 5 };
      const result = tool.callApplyDefaults(original);

      expect(result).toEqual(original);
      expect(result).not.toBe(original); // different reference
    });

    it('should preserve all existing properties', () => {
      const params = { url: 'x', count: 3, verbose: true, tags: ['a'] };
      const result = tool.callApplyDefaults(params);
      expect(result).toEqual(params);
    });

    it('should return an empty object for empty input', () => {
      const result = tool.callApplyDefaults({});
      expect(result).toEqual({});
    });
  });

  // =========================================================================
  // formatError()
  // =========================================================================

  describe('formatError()', () => {
    it('should format a string error directly', () => {
      expect(tool.callFormatError('something went wrong')).toBe('something went wrong');
    });

    it('should format an Error object as "Name: message"', () => {
      const err = new Error('file not found');
      expect(tool.callFormatError(err)).toBe('Error: file not found');
    });

    it('should format a TypeError', () => {
      const err = new TypeError('invalid argument');
      expect(tool.callFormatError(err)).toBe('TypeError: invalid argument');
    });

    it('should format a RangeError', () => {
      const err = new RangeError('index out of bounds');
      expect(tool.callFormatError(err)).toBe('RangeError: index out of bounds');
    });

    it('should format a custom-named error', () => {
      const err = new Error('tab gone');
      err.name = 'TabInvalidError';
      expect(tool.callFormatError(err)).toBe('TabInvalidError: tab gone');
    });

    it('should return "Unknown error occurred" for non-string, non-Error values', () => {
      // Cast to satisfy TS while testing the runtime fallback
      expect(tool.callFormatError(42 as unknown as string)).toBe('Unknown error occurred');
      expect(tool.callFormatError({} as unknown as string)).toBe('Unknown error occurred');
    });
  });

  // =========================================================================
  // createError()
  // =========================================================================

  describe('createError()', () => {
    it('should create a ToolError with code and message', () => {
      const err = tool.callCreateError('NOT_FOUND', 'Tab not found');
      expect(err).toEqual({
        code: 'NOT_FOUND',
        message: 'Tab not found',
        details: undefined,
      });
    });

    it('should include optional details', () => {
      const err = tool.callCreateError('VALIDATION', 'Invalid params', {
        field: 'url',
      });
      expect(err.code).toBe('VALIDATION');
      expect(err.message).toBe('Invalid params');
      expect(err.details).toEqual({ field: 'url' });
    });

    it('should allow null details', () => {
      const err = tool.callCreateError('ERR', 'msg', null);
      expect(err.details).toBeNull();
    });
  });

  // =========================================================================
  // executeWithRetry()
  // =========================================================================

  describe('executeWithRetry()', () => {
    it('should return result on first successful attempt', async () => {
      const op = vi.fn().mockResolvedValue('done');
      const result = await tool.callExecuteWithRetry(op, 3, 1);

      expect(result).toBe('done');
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed on a later attempt', async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockResolvedValue('recovered');

      const result = await tool.callExecuteWithRetry(op, 3, 1);

      expect(result).toBe('recovered');
      expect(op).toHaveBeenCalledTimes(2);
    });

    it('should throw after exhausting all retries', async () => {
      const op = vi.fn().mockRejectedValue(new Error('persistent failure'));

      await expect(tool.callExecuteWithRetry(op, 3, 1)).rejects.toThrow(
        'Operation failed after 3 attempts: persistent failure',
      );
      expect(op).toHaveBeenCalledTimes(3);
    });

    it('should call the operation the correct number of times on failure', async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      const result = await tool.callExecuteWithRetry(op, 3, 1);

      expect(result).toBe('ok');
      expect(op).toHaveBeenCalledTimes(3);
    });

    it('should coerce non-Error rejection values to Error objects', async () => {
      const op = vi.fn().mockRejectedValue('string rejection');

      await expect(tool.callExecuteWithRetry(op, 1, 1)).rejects.toThrow(
        'Operation failed after 1 attempts: string rejection',
      );
    });

    it('should include last error message when all retries exhausted', async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('error A'))
        .mockRejectedValueOnce(new Error('error B'));

      await expect(tool.callExecuteWithRetry(op, 2, 1)).rejects.toThrow(
        'Operation failed after 2 attempts: error B',
      );
    });

    it('should work with maxRetries = 1 (no retry)', async () => {
      const op = vi.fn().mockRejectedValue(new Error('single'));

      await expect(tool.callExecuteWithRetry(op, 1, 1)).rejects.toThrow(
        'Operation failed after 1 attempts: single',
      );
      expect(op).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // executeWithTimeout()
  // =========================================================================

  describe('executeWithTimeout()', () => {
    it('should return result if operation completes before timeout', async () => {
      const op = () => Promise.resolve('fast');
      const result = await tool.callExecuteWithTimeout(op, 5000);

      expect(result).toBe('fast');
    });

    it('should reject with timeout error if operation exceeds the deadline', async () => {
      // Use a very short timeout so the test is fast
      const op = () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 500));

      await expect(tool.callExecuteWithTimeout(op, 10)).rejects.toThrow(
        'Operation timed out after 10ms',
      );
    });

    it('should propagate operation errors even before timeout', async () => {
      const op = () => Promise.reject(new Error('instant failure'));

      await expect(tool.callExecuteWithTimeout(op, 30000)).rejects.toThrow(
        'instant failure',
      );
    });

    it('should resolve when operation finishes just in time', async () => {
      const op = () => Promise.resolve('just-in-time');
      const result = await tool.callExecuteWithTimeout(op, 100);

      expect(result).toBe('just-in-time');
    });
  });

  // =========================================================================
  // Chrome context & tab validation helpers
  // =========================================================================

  describe('validateChromeContext()', () => {
    it('should not throw when chrome global is defined', () => {
      // The test setup file defines globalThis.chrome
      expect(() => tool.callValidateChromeContext()).not.toThrow();
    });

    it('should throw when chrome is undefined', () => {
      const saved = globalThis.chrome;
      // The setup defines chrome via Object.defineProperty with writable: true,
      // so we can assign undefined to simulate a non-extension environment.
      (globalThis as any).chrome = undefined;

      try {
        expect(() => tool.callValidateChromeContext()).toThrow(
          'Chrome extension APIs not available',
        );
      } finally {
        (globalThis as any).chrome = saved;
      }
    });
  });

  describe('validateTabId()', () => {
    beforeEach(() => {
      // chrome.tabs.get is not in the global test setup mock, so add it here
      (chrome.tabs as any).get = vi.fn();
    });

    it('should return the tab when chrome.tabs.get resolves', async () => {
      const mockTab = { id: 42, url: 'https://example.com' } as chrome.tabs.Tab;
      (vi.mocked(chrome.tabs.get) as any).mockResolvedValue(mockTab);

      const tab = await tool.callValidateTabId(42);
      expect(tab).toBe(mockTab);
      expect(chrome.tabs.get).toHaveBeenCalledWith(42);
    });

    it('should throw when chrome.tabs.get returns null/undefined', async () => {
      vi.mocked(chrome.tabs.get).mockResolvedValue(null as any);

      await expect(tool.callValidateTabId(99)).rejects.toThrow('Invalid tab ID 99');
    });

    it('should throw when chrome.tabs.get rejects', async () => {
      vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab with that id'));

      await expect(tool.callValidateTabId(999)).rejects.toThrow('Invalid tab ID 999');
    });
  });

  describe('getActiveTab()', () => {
    it('should return the first active tab', async () => {
      const mockTab = { id: 1, active: true } as chrome.tabs.Tab;
      (vi.mocked(chrome.tabs.query) as any).mockResolvedValue([mockTab]);

      const tab = await tool.callGetActiveTab();
      expect(tab).toBe(mockTab);
      expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    });

    it('should throw when no active tab is found', async () => {
      (vi.mocked(chrome.tabs.query) as any).mockResolvedValue([]);

      await expect(tool.callGetActiveTab()).rejects.toThrow('No active tab found');
    });
  });

  // =========================================================================
  // log()
  // =========================================================================

  describe('log()', () => {
    it('should log with tool name prefix', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
      tool.callLog('info', 'hello');
      expect(spy).toHaveBeenCalledWith('[test_tool] hello');
    });

    it('should omit data to prevent circular references', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tool.callLog('warn', 'with data', { foo: 'bar' });
      expect(spy).toHaveBeenCalledWith(
        '[test_tool] with data [data omitted to prevent circular references]',
      );
    });

    it('should use the tool type for non-function definitions', () => {
      const shellTool = new TestTool({ type: 'local_shell' } as ToolDefinition);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      shellTool.callLog('debug', 'shell log');
      expect(spy).toHaveBeenCalledWith('[local_shell] shell log');
    });
  });

  // =========================================================================
  // createContext()
  // =========================================================================

  describe('createContext()', () => {
    it('should create a ToolContext with correct fields', () => {
      const ctx = tool.callCreateContext('sess_abc', 'turn_1');
      expect(ctx).toEqual({
        sessionId: 'sess_abc',
        turnId: 'turn_1',
        toolName: 'test_tool',
        metadata: undefined,
      });
    });

    it('should use tool type for non-function definitions', () => {
      const searchTool = new TestTool({ type: 'web_search' } as ToolDefinition);
      const ctx = searchTool.callCreateContext('s', 't');
      expect(ctx.toolName).toBe('web_search');
    });
  });

  // =========================================================================
  // safeStringify()
  // =========================================================================

  describe('safeStringify()', () => {
    it('should stringify simple objects', () => {
      const result = tool.callSafeStringify({ a: 1, b: 'two' });
      expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
    });

    it('should handle circular references', () => {
      const obj: any = { name: 'root' };
      obj.self = obj;

      const result = tool.callSafeStringify(obj);
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('root');
      expect(parsed.self).toBe('[Circular]');
    });

    it('should handle null and primitives', () => {
      expect(tool.callSafeStringify(null)).toBe('null');
      expect(tool.callSafeStringify(42)).toBe('42');
      expect(tool.callSafeStringify('hello')).toBe('"hello"');
    });
  });

  // =========================================================================
  // Utility functions (module-level exports)
  // =========================================================================

  describe('createFunctionTool()', () => {
    it('should create a function ToolDefinition', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      };
      const def = createFunctionTool('search', 'Search the web', schema);

      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('search');
        expect(def.function.description).toBe('Search the web');
        expect(def.function.strict).toBe(false);
        expect(def.function.parameters).toBe(schema);
      }
    });

    it('should respect the strict option', () => {
      const schema: JsonSchema = { type: 'object', properties: {} };
      const def = createFunctionTool('t', 'd', schema, { strict: true });

      if (def.type === 'function') {
        expect(def.function.strict).toBe(true);
      }
    });
  });

  describe('createObjectSchema()', () => {
    it('should create an object JsonSchema', () => {
      const schema = createObjectSchema(
        { name: { type: 'string' } },
        { required: ['name'], additionalProperties: false },
      );

      expect(schema).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      });
    });

    it('should work with no options', () => {
      const schema = createObjectSchema({ x: { type: 'number' } });
      expect(schema.type).toBe('object');
      if (schema.type === 'object') {
        expect(schema.required).toBeUndefined();
        expect(schema.additionalProperties).toBeUndefined();
      }
    });
  });

  describe('createToolDefinition()', () => {
    it('should convert ParameterProperty format to a full ToolDefinition', () => {
      const def = createToolDefinition(
        'navigate',
        'Navigate to URL',
        {
          url: { type: 'string', description: 'The URL' },
          wait: { type: 'boolean', description: 'Wait for load' },
        },
        { required: ['url'], category: 'browser', version: '1.0' },
      );

      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('navigate');
        expect(def.function.description).toBe('Navigate to URL');
        expect(def.function.strict).toBe(false);

        const params = def.function.parameters;
        expect(params.type).toBe('object');
        if (params.type === 'object') {
          expect(params.required).toEqual(['url']);
          expect(params.additionalProperties).toBe(false);
          expect(params.properties!.url).toEqual({
            type: 'string',
            description: 'The URL',
          });
          expect(params.properties!.wait).toEqual({
            type: 'boolean',
            description: 'Wait for load',
          });
        }
      }

      if (def.type === 'function') {
        expect((def as any).category).toBe('browser');
        expect((def as any).version).toBe('1.0');
      }
    });

    it('should convert nested array properties', () => {
      const def = createToolDefinition('tag', 'Tag items', {
        tags: {
          type: 'array',
          description: 'Tags list',
          items: { type: 'string', description: 'A tag' },
        },
      });

      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const tagsProp = def.function.parameters.properties!.tags;
        expect(tagsProp.type).toBe('array');
        if (tagsProp.type === 'array') {
          expect(tagsProp.items).toEqual({ type: 'string', description: 'A tag' });
        }
      }
    });

    it('should convert nested object properties', () => {
      const def = createToolDefinition('conf', 'Configure', {
        settings: {
          type: 'object',
          description: 'Settings block',
          properties: {
            mode: { type: 'string', description: 'Mode' },
          },
        },
      });

      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const settingsProp = def.function.parameters.properties!.settings;
        expect(settingsProp.type).toBe('object');
        if (settingsProp.type === 'object') {
          expect(settingsProp.properties!.mode).toEqual({
            type: 'string',
            description: 'Mode',
          });
        }
      }
    });

    it('should include metadata when provided', () => {
      const def = createToolDefinition(
        'tool',
        'desc',
        {},
        {
          metadata: {
            capabilities: ['dom'],
            permissions: ['tabs'],
            platforms: ['extension'],
          },
        },
      );

      if (def.type === 'function') {
        expect((def as any).metadata).toEqual({
          capabilities: ['dom'],
          permissions: ['tabs'],
          platforms: ['extension'],
        });
      }
    });
  });
});
