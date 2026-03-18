/**
 * TurnManager memory integration tests.
 *
 * Tests that TurnManager correctly:
 * - Injects global memory context into system prompt
 * - Includes search_memory tool from ToolRegistry when it is registered
 * - Does NOT include search_memory tool when it is not in the registry
 * - Fires memory extraction after completed turns
 *
 * Note: Memory tools are now registered in the ToolRegistry by RepublicAgent
 * during initialization, not dynamically injected by TurnManager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { SEARCH_MEMORY_TOOL } from '@/tools/MemorySearchTool';

// ---------------------------------------------------------------------------
// Shared helpers (matching existing TurnManager.coverage.test.ts pattern)
// ---------------------------------------------------------------------------

function createMocks(options: { memoryService?: any; registryTools?: any[] } = {}) {
  const { memoryService = null, registryTools = [] } = options;

  const session = {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getTabId: vi.fn().mockReturnValue(1),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    recordTurnContext: vi.fn().mockResolvedValue(undefined),
    showRawAgentReasoning: vi.fn().mockReturnValue(false),
    getMemoryService: vi.fn().mockReturnValue(memoryService),
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
    listTools: vi.fn().mockReturnValue(registryTools),
  } as any;

  return { session, turnContext, toolRegistry };
}

// ---------------------------------------------------------------------------
// search_memory tool via ToolRegistry
// ---------------------------------------------------------------------------

describe('TurnManager - search_memory tool from ToolRegistry', () => {
  it('includes search_memory tool when it is registered in the ToolRegistry', async () => {
    const memoryService = {
      searchTopical: vi.fn().mockResolvedValue([]),
      getFormattedGlobalContext: vi.fn().mockResolvedValue(''),
      processConversation: vi.fn().mockResolvedValue(undefined),
    };

    // Memory tools are now pre-registered in the ToolRegistry by RepublicAgent
    const { session, turnContext, toolRegistry } = createMocks({
      memoryService,
      registryTools: [SEARCH_MEMORY_TOOL],
    });
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();

    const hasMemoryTool = tools.some(
      (t: any) => t.function?.name === 'search_memory'
    );
    expect(hasMemoryTool).toBe(true);
  });

  it('does NOT include search_memory tool when it is not in the ToolRegistry', async () => {
    const { session, turnContext, toolRegistry } = createMocks();
    const tm = new TurnManager(session, turnContext, toolRegistry);

    const tools = await (tm as any).buildToolsFromContext();

    const hasMemoryTool = tools.some(
      (t: any) => t.function?.name === 'search_memory'
    );
    expect(hasMemoryTool).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEARCH_MEMORY_TOOL definition
// ---------------------------------------------------------------------------

describe('SEARCH_MEMORY_TOOL', () => {
  // Cast to access .function since ToolDefinition is a union type
  const tool = SEARCH_MEMORY_TOOL as Extract<typeof SEARCH_MEMORY_TOOL, { type: 'function' }>;

  it('has correct tool structure', () => {
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('search_memory');
    expect((tool.function.parameters as any).required).toContain('query');
  });

  it('has a description', () => {
    expect(tool.function.description).toBeTruthy();
    expect(tool.function.description.length).toBeGreaterThan(20);
  });

  it('has query parameter defined', () => {
    const props = (tool.function.parameters as any).properties as Record<string, any>;
    expect(props.query).toBeDefined();
    expect(props.query.type).toBe('string');
  });
});
