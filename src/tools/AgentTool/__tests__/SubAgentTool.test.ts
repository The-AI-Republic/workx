/**
 * Tests for SubAgentTool.ts and register.ts
 *
 * Covers:
 * - buildSubAgentToolDefinition: shape, name, strict, enum, descriptions, required, properties, edge cases
 * - registerSubAgentTool: registration, runner creation, handler validation, param forwarding, result shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSubAgentToolDefinition } from '../SubAgentTool';
import { registerSubAgentTool } from '../register';
import { BUILTIN_SUBAGENT_TYPES } from '../builtinTypes';
import type { SubAgentTypeConfig } from '../types';
import type { ToolDefinition } from '../../BaseTool';

// ---------------------------------------------------------------------------
// Mock SubAgentRunner — avoid pulling in real engine dependencies
// ---------------------------------------------------------------------------

// Use vi.hoisted to ensure the mock fn is available when vi.mock runs.
const { mockRunnerRun } = vi.hoisted(() => ({
  mockRunnerRun: vi.fn(),
}));

vi.mock('../SubAgentRunner', () => {
  return {
    SubAgentRunner: class MockSubAgentRunner {
      run = mockRunnerRun;
      getRegistry = vi.fn();
      getTypes = vi.fn();
      cancelAll = vi.fn();
    },
  };
});

vi.mock('../SubAgentRegistry', () => ({
  SubAgentRegistry: class MockSubAgentRegistry {
    constructor() {}
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleTypes(): SubAgentTypeConfig[] {
  return [
    {
      id: 'alpha',
      name: 'Alpha',
      description: 'Does alpha work',
      systemPrompt: 'You are alpha',
    },
    {
      id: 'beta',
      name: 'Beta',
      description: 'Does beta work',
      systemPrompt: 'You are beta',
    },
  ];
}

/** Extract the `function` block from a ToolDefinition, asserting it is a function tool. */
function assertFunctionTool(def: ToolDefinition) {
  expect(def.type).toBe('function');
  if (def.type !== 'function') throw new Error('not a function tool');
  return def.function;
}

/** Create a mock RepublicAgentEngine with a capturable tool handler. */
function createMockEngine() {
  const capturedHandlers = new Map<string, (params: Record<string, unknown>, context: unknown) => Promise<string>>();
  const capturedDefinitions = new Map<string, ToolDefinition>();

  const mockRegister = vi.fn(
    async (definition: ToolDefinition, handler: (params: Record<string, unknown>, context: unknown) => Promise<string>) => {
      const name = definition.type === 'function' ? definition.function.name : 'unknown';
      capturedDefinitions.set(name, definition);
      capturedHandlers.set(name, handler);
    },
  );

  const mockToolRegistry = {
    register: mockRegister,
  };

  const engine = {
    engineId: 'engine-test-123',
    getToolRegistry: vi.fn(() => mockToolRegistry),
    getConfig: vi.fn(() => ({
      agentConfig: { getConfig: () => ({}) },
    })),
    pushEvent: vi.fn(),
  } as any;

  return {
    engine,
    mockRegister,
    mockToolRegistry,
    /** Get the sub_agent tool handler (first registered) */
    getCapturedHandler: () => capturedHandlers.get('sub_agent'),
    getCapturedDefinition: () => capturedDefinitions.get('sub_agent'),
    /** Get handler by tool name */
    getHandler: (name: string) => capturedHandlers.get(name),
    getDefinition: (name: string) => capturedDefinitions.get(name),
  };
}

// ============================================================================
// buildSubAgentToolDefinition
// ============================================================================

describe('buildSubAgentToolDefinition', () => {
  it('returns type "function"', () => {
    const def = buildSubAgentToolDefinition(sampleTypes());
    expect(def.type).toBe('function');
  });

  it('sets name to "sub_agent"', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    expect(fn.name).toBe('sub_agent');
  });

  it('sets strict to false', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    expect(fn.strict).toBe(false);
  });

  it('generates enum from type ids', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    const params = fn.parameters as {
      type: 'object';
      properties: Record<string, any>;
    };
    expect(params.properties.type.enum).toEqual(['alpha', 'beta']);
  });

  it('includes type descriptions in description text', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    expect(fn.description).toContain('"alpha": Does alpha work');
    expect(fn.description).toContain('"beta": Does beta work');
  });

  it('has required fields ["type", "prompt"]', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    const params = fn.parameters as { type: 'object'; required: string[] };
    expect(params.required).toEqual(['type', 'prompt']);
  });

  it('includes all parameter properties', () => {
    const fn = assertFunctionTool(buildSubAgentToolDefinition(sampleTypes()));
    const params = fn.parameters as {
      type: 'object';
      properties: Record<string, any>;
    };
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining(['type', 'prompt', 'description', 'background', 'context_mode']),
    );
    expect(Object.keys(params.properties)).toHaveLength(5);
  });

  it('works with empty types array', () => {
    const def = buildSubAgentToolDefinition([]);
    const fn = assertFunctionTool(def);
    const params = fn.parameters as {
      type: 'object';
      properties: Record<string, any>;
    };
    // enum should be empty
    expect(params.properties.type.enum).toEqual([]);
    // description should still contain the header text
    expect(fn.description).toContain('Available types:');
  });

  it('works with BUILTIN_SUBAGENT_TYPES', () => {
    const def = buildSubAgentToolDefinition(BUILTIN_SUBAGENT_TYPES);
    const fn = assertFunctionTool(def);
    const params = fn.parameters as {
      type: 'object';
      properties: Record<string, any>;
    };

    const ids = BUILTIN_SUBAGENT_TYPES.map(t => t.id);
    expect(params.properties.type.enum).toEqual(ids);

    // Every built-in description should appear
    for (const t of BUILTIN_SUBAGENT_TYPES) {
      expect(fn.description).toContain(t.description);
    }
  });
});

// ============================================================================
// registerSubAgentTool
// ============================================================================

describe('registerSubAgentTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunnerRun.mockReset();
  });

  it('registers tool in engine\'s tool registry', async () => {
    const { engine, mockRegister, getCapturedDefinition } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });

    expect(engine.getToolRegistry).toHaveBeenCalled();
    // 4 tools: sub_agent + list_sub_agents + cancel_sub_agent + send_message
    expect(mockRegister).toHaveBeenCalledTimes(4);

    // First registered tool should be sub_agent
    const registeredDef = getCapturedDefinition()!;
    expect(registeredDef).toBeDefined();
    expect(registeredDef.type).toBe('function');
    if (registeredDef.type === 'function') {
      expect(registeredDef.function.name).toBe('sub_agent');
    }
  });

  it('registers management tools (list, cancel, send_message)', async () => {
    const { engine, getDefinition } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });

    expect(getDefinition('list_sub_agents')).toBeDefined();
    expect(getDefinition('cancel_sub_agent')).toBeDefined();
    expect(getDefinition('send_message')).toBeDefined();
  });

  it('returns a SubAgentRunner instance', async () => {
    const { engine } = createMockEngine();
    const runner = await registerSubAgentTool(engine, { types: sampleTypes() });

    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe('function');
  });

  // ---------- handler validation tests ----------

  it('tool handler validates missing type parameter', async () => {
    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;
    expect(handler).toBeDefined();

    const result = await handler({ prompt: 'do something' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('type');
  });

  it('tool handler validates missing prompt parameter', async () => {
    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    const result = await handler({ type: 'alpha' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('prompt');
  });

  it('tool handler validates empty type string', async () => {
    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    const result = await handler({ type: '', prompt: 'do something' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('type');
  });

  it('tool handler validates empty prompt string', async () => {
    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    const result = await handler({ type: 'alpha', prompt: '' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('prompt');
  });

  it('tool handler passes valid params to runner.run()', async () => {
    const mockResult = {
      success: true,
      response: 'done',
      runId: 'run-1',
      turnCount: 2,
      stopReason: 'completed',
    };
    mockRunnerRun.mockResolvedValue(mockResult);

    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    await handler({ type: 'alpha', prompt: 'do the thing' }, {});

    expect(mockRunnerRun).toHaveBeenCalledTimes(1);
    expect(mockRunnerRun).toHaveBeenCalledWith({
      type: 'alpha',
      prompt: 'do the thing',
      description: undefined,
      background: false,
    });
  });

  it('tool handler returns JSON string result', async () => {
    const mockResult = {
      success: true,
      response: 'task completed',
      runId: 'run-abc',
      turnCount: 5,
      stopReason: 'completed',
    };
    mockRunnerRun.mockResolvedValue(mockResult);

    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    const result = await handler({ type: 'alpha', prompt: 'do the thing' }, {});
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(mockResult);
  });

  it('handles type-safe optional params (description)', async () => {
    const mockResult = {
      success: true,
      response: 'ok',
      runId: 'run-opt',
      turnCount: 1,
      stopReason: 'completed',
    };
    mockRunnerRun.mockResolvedValue(mockResult);

    const { engine, getCapturedHandler } = createMockEngine();
    await registerSubAgentTool(engine, { types: sampleTypes() });
    const handler = getCapturedHandler()!;

    // With valid optional params
    await handler(
      {
        type: 'alpha',
        prompt: 'research this',
        description: 'quick research',
      },
      {},
    );

    expect(mockRunnerRun).toHaveBeenCalledWith({
      type: 'alpha',
      prompt: 'research this',
      description: 'quick research',
      background: false,
    });

    // With wrong types for optional params — they should be coerced to undefined
    mockRunnerRun.mockClear();
    await handler(
      {
        type: 'beta',
        prompt: 'do stuff',
        description: 123, // not a string
      },
      {},
    );

    expect(mockRunnerRun).toHaveBeenCalledWith({
      type: 'beta',
      prompt: 'do stuff',
      description: undefined,
      background: false,
    });
  });
});
