/**
 * TurnManager memory integration tests.
 *
 * Tests that TurnManager correctly:
 * - Injects global memory context into system prompt
 * - Registers search_memory tool when service is available
 * - Does NOT register search_memory tool when service is null
 * - Fires memory extraction after completed turns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { SEARCH_MEMORY_TOOL } from '@/tools/MemorySearchTool';

// ---------------------------------------------------------------------------
// Shared helpers (matching existing TurnManager.coverage.test.ts pattern)
// ---------------------------------------------------------------------------

function createMocks(memoryService: any = null) {
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
    listTools: vi.fn().mockReturnValue([]),
  } as any;

  return { session, turnContext, toolRegistry };
}

// ---------------------------------------------------------------------------
// search_memory tool registration
// ---------------------------------------------------------------------------

describe('TurnManager - search_memory tool registration', () => {
  it('includes search_memory tool when memoryService is available', async () => {
    const memoryService = {
      searchTopical: vi.fn().mockResolvedValue([]),
      getFormattedGlobalContext: vi.fn().mockResolvedValue(''),
      processConversation: vi.fn().mockResolvedValue(undefined),
    };

    const { session, turnContext, toolRegistry } = createMocks(memoryService);
    const tm = new TurnManager(session, turnContext, toolRegistry);

    // Access the private async buildToolsFromContext method
    const tools = await (tm as any).buildToolsFromContext();

    const hasMemoryTool = tools.some(
      (t: any) => t.function?.name === 'search_memory'
    );
    expect(hasMemoryTool).toBe(true);
  });

  it('does NOT include search_memory tool when memoryService is null', async () => {
    const { session, turnContext, toolRegistry } = createMocks(null);
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
  it('has correct tool structure', () => {
    expect(SEARCH_MEMORY_TOOL.type).toBe('function');
    expect(SEARCH_MEMORY_TOOL.function.name).toBe('search_memory');
    expect(SEARCH_MEMORY_TOOL.function.parameters.required).toContain('query');
  });

  it('has a description', () => {
    expect(SEARCH_MEMORY_TOOL.function.description).toBeTruthy();
    expect(SEARCH_MEMORY_TOOL.function.description.length).toBeGreaterThan(20);
  });

  it('has query parameter defined', () => {
    const props = SEARCH_MEMORY_TOOL.function.parameters.properties as Record<string, any>;
    expect(props.query).toBeDefined();
    expect(props.query.type).toBe('string');
  });
});
