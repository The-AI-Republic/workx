/**
 * Comprehensive coverage tests for ToolRegistry
 *
 * Covers methods NOT tested by:
 *   - ToolRegistry.config.test.ts (constructor, basic register, duplicate rejection, discover basic)
 *   - ToolRegistry.approval.test.ts (approval gate integration with real ApprovalGate/PolicyRulesEngine)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { IEventCollector } from '@/tools/ToolRegistry';
import type { ToolDefinition, ToolHandler } from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFunctionTool(
  name: string,
  params: Record<string, any> = {},
  required: string[] = [],
  options: { strict?: boolean; additionalProperties?: boolean } = {},
): ToolDefinition {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `Test tool: ${name}`,
      strict: options.strict ?? true,
      parameters: {
        type: 'object' as const,
        properties: params,
        required,
        additionalProperties: options.additionalProperties ?? false,
      },
    },
  };
}

function noopHandler(): ToolHandler {
  return vi.fn().mockResolvedValue({ ok: true });
}

function makeRequest(toolName: string, parameters: Record<string, any> = {}) {
  return {
    toolName,
    parameters,
    sessionId: 'sess_1',
    turnId: 'turn_1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolRegistry – extended coverage', () => {
  let registry: ToolRegistry;
  let collector: IEventCollector;

  beforeEach(() => {
    collector = { collect: vi.fn() };
    registry = new ToolRegistry(collector);
  });

  // -----------------------------------------------------------------------
  // unregister
  // -----------------------------------------------------------------------
  describe('unregister', () => {
    it('should remove a previously registered tool', async () => {
      const tool = createFunctionTool('removable');
      await registry.register(tool, noopHandler());
      expect(registry.getTool('removable')).not.toBeNull();

      await registry.unregister('removable');
      expect(registry.getTool('removable')).toBeNull();
    });

    it('should emit an unregistration event', async () => {
      const tool = createFunctionTool('evt_tool');
      await registry.register(tool, noopHandler());
      (collector.collect as ReturnType<typeof vi.fn>).mockClear();

      await registry.unregister('evt_tool');

      expect(collector.collect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'evt_unregister_evt_tool',
          msg: expect.objectContaining({ type: 'ToolUnregistered' }),
        }),
      );
    });

    it('should throw when unregistering a tool that does not exist', async () => {
      await expect(registry.unregister('nonexistent')).rejects.toThrow(
        "Tool 'nonexistent' not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // validate
  // -----------------------------------------------------------------------
  describe('validate', () => {
    it('should return NOT_FOUND for an unregistered tool', () => {
      const result = registry.validate('ghost', {});
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('NOT_FOUND');
    });

    it('should pass validation when all required params are present and typed correctly', async () => {
      const tool = createFunctionTool(
        'typed',
        { name: { type: 'string', description: 'n' } },
        ['name'],
      );
      await registry.register(tool, noopHandler());

      const result = registry.validate('typed', { name: 'Alice' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when a required param is missing', async () => {
      const tool = createFunctionTool(
        'req',
        { age: { type: 'number', description: 'a' } },
        ['age'],
      );
      await registry.register(tool, noopHandler());

      const result = registry.validate('req', {});
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ parameter: 'age', code: 'REQUIRED' }),
        ]),
      );
    });

    it('should fail when a required param is null', async () => {
      const tool = createFunctionTool(
        'req_null',
        { age: { type: 'number', description: 'a' } },
        ['age'],
      );
      await registry.register(tool, noopHandler());

      const result = registry.validate('req_null', { age: null });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'REQUIRED')).toBe(true);
    });

    it('should reject unknown parameters when additionalProperties is false', async () => {
      const tool = createFunctionTool('strict_params', {}, []);
      await registry.register(tool, noopHandler());

      const result = registry.validate('strict_params', { rogue: 42 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('UNKNOWN_PARAMETER');
    });

    it('should allow unknown parameters when additionalProperties is true', async () => {
      const tool = createFunctionTool('loose_params', {}, [], {
        additionalProperties: true,
      });
      await registry.register(tool, noopHandler());

      const result = registry.validate('loose_params', { extra: 'ok' });
      expect(result.valid).toBe(true);
    });

    it('should skip strict validation when strict is false', async () => {
      const tool = createFunctionTool(
        'nonstrict',
        { x: { type: 'string', description: 'x' } },
        ['x'],
        { strict: false },
      );
      await registry.register(tool, noopHandler());

      // Missing required param 'x', but strict=false => skip validation
      const result = registry.validate('nonstrict', {});
      expect(result.valid).toBe(true);
    });

    // --- Type mismatch tests ---
    describe('type validation', () => {
      async function registerTypedTool(
        name: string,
        paramSchema: Record<string, any>,
      ) {
        const tool = createFunctionTool(name, { val: paramSchema }, []);
        await registry.register(tool, noopHandler());
      }

      it('should reject number when string expected', async () => {
        await registerTypedTool('str_check', { type: 'string', description: 's' });
        const r = registry.validate('str_check', { val: 123 });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should reject string when number expected', async () => {
        await registerTypedTool('num_check', { type: 'number', description: 'n' });
        const r = registry.validate('num_check', { val: 'oops' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should reject NaN when number expected', async () => {
        await registerTypedTool('nan_check', { type: 'number', description: 'n' });
        const r = registry.validate('nan_check', { val: NaN });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should reject float when integer expected', async () => {
        await registerTypedTool('int_check', { type: 'integer', description: 'i' });
        const r = registry.validate('int_check', { val: 3.14 });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should accept a valid integer', async () => {
        await registerTypedTool('int_ok', { type: 'integer', description: 'i' });
        const r = registry.validate('int_ok', { val: 7 });
        expect(r.valid).toBe(true);
      });

      it('should reject string when boolean expected', async () => {
        await registerTypedTool('bool_check', { type: 'boolean', description: 'b' });
        const r = registry.validate('bool_check', { val: 'true' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should reject object when array expected', async () => {
        await registerTypedTool('arr_check', {
          type: 'array',
          items: { type: 'string' },
          description: 'a',
        });
        const r = registry.validate('arr_check', { val: {} });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should accept a valid array', async () => {
        await registerTypedTool('arr_ok', {
          type: 'array',
          items: { type: 'string' },
          description: 'a',
        });
        const r = registry.validate('arr_ok', { val: ['a', 'b'] });
        expect(r.valid).toBe(true);
      });

      it('should reject array item type mismatch', async () => {
        await registerTypedTool('arr_items', {
          type: 'array',
          items: { type: 'number' },
          description: 'a',
        });
        const r = registry.validate('arr_items', { val: [1, 'bad', 3] });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should reject array when object expected', async () => {
        await registerTypedTool('obj_check', {
          type: 'object',
          properties: {},
          description: 'o',
        });
        const r = registry.validate('obj_check', { val: [1, 2] });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should accept a valid object', async () => {
        await registerTypedTool('obj_ok', {
          type: 'object',
          properties: { nested: { type: 'string' } },
          description: 'o',
        });
        const r = registry.validate('obj_ok', { val: { nested: 'hi' } });
        expect(r.valid).toBe(true);
      });

      it('should reject nested object property type mismatch', async () => {
        await registerTypedTool('obj_nested', {
          type: 'object',
          properties: { count: { type: 'number' } },
          description: 'o',
        });
        const r = registry.validate('obj_nested', { val: { count: 'bad' } });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('TYPE_MISMATCH');
      });

      it('should return NULL_VALUE for null parameter value', async () => {
        await registerTypedTool('null_check', { type: 'string', description: 'n' });
        const r = registry.validate('null_check', { val: null });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('NULL_VALUE');
      });

      it('should return UNKNOWN_TYPE for an unrecognised schema type', async () => {
        await registerTypedTool('unk_type', { type: 'date', description: 'd' } as any);
        const r = registry.validate('unk_type', { val: '2024-01-01' });
        expect(r.valid).toBe(false);
        expect(r.errors[0].code).toBe('UNKNOWN_TYPE');
      });
    });
  });

  // -----------------------------------------------------------------------
  // execute
  // -----------------------------------------------------------------------
  describe('execute', () => {
    it('should return TOOL_NOT_FOUND for an unregistered tool', async () => {
      const res = await registry.execute(makeRequest('missing'));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('TOOL_NOT_FOUND');
    });

    it('should return VALIDATION_ERROR when params are invalid', async () => {
      const tool = createFunctionTool(
        'needs_name',
        { name: { type: 'string', description: 'n' } },
        ['name'],
      );
      await registry.register(tool, noopHandler());

      const res = await registry.execute(makeRequest('needs_name', {}));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should succeed and return handler data on valid call', async () => {
      const handler = vi.fn().mockResolvedValue({ answer: 42 });
      const tool = createFunctionTool('calc', {}, []);
      await registry.register(tool, handler);

      const res = await registry.execute(makeRequest('calc'));
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ answer: 42 });
      expect(res.duration).toBeGreaterThanOrEqual(0);
    });

    it('should pass context with toolName, sessionId, turnId to handler', async () => {
      const handler = vi.fn().mockResolvedValue('ok');
      const tool = createFunctionTool('ctx_tool', {}, []);
      await registry.register(tool, handler);

      await registry.execute({
        toolName: 'ctx_tool',
        parameters: {},
        sessionId: 'S1',
        turnId: 'T1',
      });

      expect(handler).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          sessionId: 'S1',
          turnId: 'T1',
          toolName: 'ctx_tool',
        }),
      );
    });

    it('should return TIMEOUT when handler exceeds timeout', async () => {
      const slowHandler = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000)),
      );
      const tool = createFunctionTool('slow', {}, []);
      await registry.register(tool, slowHandler);

      const res = await registry.execute({
        ...makeRequest('slow'),
        timeout: 50, // 50 ms
      });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('TIMEOUT');
    });

    it('should return EXECUTION_ERROR when handler throws', async () => {
      const badHandler = vi.fn().mockRejectedValue(new Error('kaboom'));
      const tool = createFunctionTool('boom', {}, []);
      await registry.register(tool, badHandler);

      const res = await registry.execute(makeRequest('boom'));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('EXECUTION_ERROR');
      expect(res.error?.message).toBe('kaboom');
    });

    it('should emit start and end events on successful execution', async () => {
      const tool = createFunctionTool('evented', {}, []);
      await registry.register(tool, noopHandler());
      (collector.collect as ReturnType<typeof vi.fn>).mockClear();

      await registry.execute(makeRequest('evented'));

      const events = (collector.collect as ReturnType<typeof vi.fn>).mock.calls.map(
        c => c[0].msg.type,
      );
      expect(events).toContain('ToolExecutionStart');
      expect(events).toContain('ToolExecutionEnd');
    });

    it('should emit error event when handler throws', async () => {
      const tool = createFunctionTool('err_evt', {}, []);
      await registry.register(tool, vi.fn().mockRejectedValue(new Error('fail')));
      (collector.collect as ReturnType<typeof vi.fn>).mockClear();

      await registry.execute(makeRequest('err_evt'));

      const events = (collector.collect as ReturnType<typeof vi.fn>).mock.calls.map(
        c => c[0].msg.type,
      );
      expect(events).toContain('ToolExecutionError');
    });

    it('should emit timeout event when handler times out', async () => {
      const tool = createFunctionTool('to_evt', {}, []);
      await registry.register(
        tool,
        vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 5000))),
      );
      (collector.collect as ReturnType<typeof vi.fn>).mockClear();

      await registry.execute({ ...makeRequest('to_evt'), timeout: 30 });

      const events = (collector.collect as ReturnType<typeof vi.fn>).mock.calls.map(
        c => c[0].msg.type,
      );
      expect(events).toContain('ToolExecutionTimeout');
    });

    it('should return APPROVAL_DENIED when approval gate denies', async () => {
      const tool = createFunctionTool('gated', {}, []);
      await registry.register(tool, noopHandler());

      // Minimal mock approval gate that always denies
      const gate = {
        check: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'policy' }),
      } as any;
      registry.setApprovalGate(gate);

      const res = await registry.execute(makeRequest('gated'));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('APPROVAL_DENIED');

      const events = (collector.collect as ReturnType<typeof vi.fn>).mock.calls.map(
        c => c[0].msg.type,
      );
      expect(events).toContain('ToolExecutionStart');
    });

    it('should proceed when approval gate returns auto_approve', async () => {
      const tool = createFunctionTool('approved', {}, []);
      const handler = vi.fn().mockResolvedValue('done');
      await registry.register(tool, handler);

      const gate = {
        check: vi.fn().mockResolvedValue('auto_approve'),
      } as any;
      registry.setApprovalGate(gate);

      const res = await registry.execute(makeRequest('approved'));
      expect(res.success).toBe(true);
      expect(handler).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // discover
  // -----------------------------------------------------------------------
  describe('discover', () => {
    it('should return all tools when no query is provided', async () => {
      await registry.register(createFunctionTool('a'), noopHandler());
      await registry.register(createFunctionTool('b'), noopHandler());

      const result = await registry.discover();
      expect(result.total).toBe(2);
    });

    it('should filter by namePattern regex', async () => {
      await registry.register(createFunctionTool('browser_navigate'), noopHandler());
      await registry.register(createFunctionTool('browser_click'), noopHandler());
      await registry.register(createFunctionTool('file_read'), noopHandler());

      const result = await registry.discover({ namePattern: '^browser_' });
      expect(result.total).toBe(2);
      expect(result.tools.every(t => t.type === 'function')).toBe(true);
    });

    it('should return empty results when pattern matches nothing', async () => {
      await registry.register(createFunctionTool('alpha'), noopHandler());

      const result = await registry.discover({ namePattern: 'zzz' });
      expect(result.total).toBe(0);
      expect(result.tools).toHaveLength(0);
    });

    it('namePattern matching should be case-insensitive', async () => {
      await registry.register(createFunctionTool('MyTool'), noopHandler());

      const result = await registry.discover({ namePattern: 'mytool' });
      expect(result.total).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // getTool
  // -----------------------------------------------------------------------
  describe('getTool', () => {
    it('should return the tool definition for a registered tool', async () => {
      const tool = createFunctionTool('getter');
      await registry.register(tool, noopHandler());

      expect(registry.getTool('getter')).toEqual(tool);
    });

    it('should return null for an unregistered tool', () => {
      expect(registry.getTool('phantom')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // listTools
  // -----------------------------------------------------------------------
  describe('listTools', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.listTools()).toEqual([]);
    });

    it('should list all registered tool definitions', async () => {
      const t1 = createFunctionTool('l1');
      const t2 = createFunctionTool('l2');
      await registry.register(t1, noopHandler());
      await registry.register(t2, noopHandler());

      const list = registry.listTools();
      expect(list).toHaveLength(2);
      expect(list).toEqual(expect.arrayContaining([t1, t2]));
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------
  describe('getStats', () => {
    it('should report zero tools when empty', () => {
      const stats = registry.getStats();
      expect(stats.totalTools).toBe(0);
      expect(stats.registeredTools).toEqual([]);
    });

    it('should report correct counts and names', async () => {
      await registry.register(createFunctionTool('s1'), noopHandler());
      await registry.register(createFunctionTool('s2'), noopHandler());

      const stats = registry.getStats();
      expect(stats.totalTools).toBe(2);
      expect(stats.registeredTools).toEqual(expect.arrayContaining(['s1', 's2']));
      expect(stats.categories).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------
  describe('clear', () => {
    it('should remove all registered tools', async () => {
      await registry.register(createFunctionTool('c1'), noopHandler());
      await registry.register(createFunctionTool('c2'), noopHandler());
      expect(registry.listTools()).toHaveLength(2);

      registry.clear();
      expect(registry.listTools()).toHaveLength(0);
      expect(registry.getStats().totalTools).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // setApprovalGate / getApprovalGate
  // -----------------------------------------------------------------------
  describe('setApprovalGate / getApprovalGate', () => {
    it('should return undefined when no gate is set', () => {
      expect(registry.getApprovalGate()).toBeUndefined();
    });

    it('should store and return the gate', () => {
      const gate = { check: vi.fn() } as any;
      registry.setApprovalGate(gate);
      expect(registry.getApprovalGate()).toBe(gate);
    });
  });

  // -----------------------------------------------------------------------
  // validateToolDefinition (tested indirectly via register)
  // -----------------------------------------------------------------------
  describe('validateToolDefinition (via register)', () => {
    const handler = noopHandler();

    it('should throw on missing type', async () => {
      await expect(
        registry.register({} as any, handler),
      ).rejects.toThrow('missing type');
    });

    it('should throw on null tool', async () => {
      await expect(
        registry.register(null as any, handler),
      ).rejects.toThrow('missing type');
    });

    it('should throw on empty name', async () => {
      const bad: any = {
        type: 'function',
        function: {
          name: '   ',
          description: 'valid desc',
          strict: true,
          parameters: { type: 'object', properties: {} },
        },
      };
      await expect(registry.register(bad, handler)).rejects.toThrow('missing required field: name');
    });

    it('should throw on empty description', async () => {
      const bad: any = {
        type: 'function',
        function: {
          name: 'good_name',
          description: '',
          strict: true,
          parameters: { type: 'object', properties: {} },
        },
      };
      await expect(registry.register(bad, handler)).rejects.toThrow(
        'missing required field: description',
      );
    });

    it('should throw when parameters is not an object (e.g. null)', async () => {
      const bad: any = {
        type: 'function',
        function: {
          name: 'no_params',
          description: 'desc',
          strict: true,
          parameters: null,
        },
      };
      await expect(registry.register(bad, handler)).rejects.toThrow(
        'missing required field: parameters',
      );
    });

    it('should throw when parameters.type is not "object"', async () => {
      const bad: any = {
        type: 'function',
        function: {
          name: 'bad_ptype',
          description: 'desc',
          strict: true,
          parameters: { type: 'array', items: { type: 'string' } },
        },
      };
      await expect(registry.register(bad, handler)).rejects.toThrow(
        'parameters must be of type "object"',
      );
    });

    it('should throw when parameters.properties is missing', async () => {
      const bad: any = {
        type: 'function',
        function: {
          name: 'no_props',
          description: 'desc',
          strict: true,
          parameters: { type: 'object' },
        },
      };
      await expect(registry.register(bad, handler)).rejects.toThrow(
        'must define properties',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getToolName (tested indirectly via register / discover)
  // -----------------------------------------------------------------------
  describe('getToolName (via register)', () => {
    const handler = noopHandler();

    it('should recognise custom type tools', async () => {
      const customTool: ToolDefinition = {
        type: 'custom',
        custom: {
          name: 'my_custom',
          description: 'A custom tool',
          format: { type: 'xml', syntax: 'xml', definition: '<tool/>' },
        },
      };
      await registry.register(customTool, handler);
      expect(registry.getTool('my_custom')).toEqual(customTool);
    });

    it('should recognise web_search type tools', async () => {
      const wsTool: ToolDefinition = { type: 'web_search' };
      await registry.register(wsTool, handler);
      expect(registry.getTool('web_search')).toEqual(wsTool);
    });

    it('should recognise local_shell type tools', async () => {
      const lsTool: ToolDefinition = { type: 'local_shell' };
      await registry.register(lsTool, handler);
      expect(registry.getTool('local_shell')).toEqual(lsTool);
    });

    it('should throw for unknown tool type', async () => {
      const unknown: any = { type: 'alien', alien: { name: 'x', description: 'x' } };
      await expect(registry.register(unknown, handler)).rejects.toThrow(
        'Unknown tool type',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Edge-case: event collector not set (no-op path)
  // -----------------------------------------------------------------------
  describe('event emission without collector', () => {
    it('should not throw when no event collector is configured', async () => {
      const bare = new ToolRegistry(); // no collector
      const tool = createFunctionTool('silent');
      await bare.register(tool, noopHandler());
      await bare.unregister('silent');
      // No error means the emitEvent no-op path works
    });
  });

  // -----------------------------------------------------------------------
  // cleanup
  // -----------------------------------------------------------------------
  describe('cleanup', () => {
    it('should resolve without error', async () => {
      await expect(registry.cleanup()).resolves.toBeUndefined();
    });
  });
});
