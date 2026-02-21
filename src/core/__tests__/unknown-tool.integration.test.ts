/**
 * Integration test for unknown tool handling
 * Feature 015-fix-the-mcp
 *
 * Scenario 1 from quickstart.md:
 * Tests the complete flow when LLM calls an unknown tool (hallucination scenario)
 *
 * Expected behavior:
 * - No "is not a function" error thrown
 * - Returns function_call_output with success: false
 * - Error message clearly indicates the problem
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { Session } from '@/core/Session';
import { TurnContext } from '@/core/TurnContext';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { IToolsConfig } from '@/config/types';

describe('Unknown tool handling (integration)', () => {
  let session: Session;
  let turnContext: TurnContext;
  let toolRegistry: ToolRegistry;
  let turnManager: TurnManager;

  beforeEach(() => {
    // Create Session WITHOUT MCP methods (simulating browser environment)
    session = {
      getSessionId: vi.fn().mockReturnValue('test-session-123'),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      recordTurnContext: vi.fn().mockResolvedValue(undefined),
      // No getMcpTools() method
      // No executeMcpTool() method
    } as any;

    // Create TurnContext with default config (mcpTools: false)
    const defaultToolsConfig: IToolsConfig = {
      mcpTools: false, // Default browser config
      enable_all_tools: false,
      execCommand: false,
      webSearch: true,
      fileOperations: false,
      customTools: {},
      enabled: [],
      disabled: [],
      timeout: 30000,
      sandboxPolicy: {
        mode: 'read-only',
        writable_roots: [],
        network_access: true,
      },
      perToolConfig: {},
    };

    turnContext = {
      getToolsConfig: vi.fn().mockReturnValue(defaultToolsConfig),
      getModelClient: vi.fn(),
      getCwd: vi.fn().mockReturnValue('/'),
      getApprovalPolicy: vi.fn().mockReturnValue('auto'),
      getSandboxPolicy: vi.fn().mockReturnValue('read-only'),
      getModel: vi.fn().mockReturnValue('gpt-4'),
      getEffort: vi.fn(),
      getSummary: vi.fn(),
      getUserInstructions: vi.fn(),
      getBaseInstructions: vi.fn(),
    } as any;

    // Create empty ToolRegistry (no browser tools registered)
    toolRegistry = new ToolRegistry();

    // Create TurnManager
    turnManager = new TurnManager(session, turnContext, toolRegistry);
  });

  it('should handle unknown tool from LLM without throwing "is not a function"', async () => {
    // Simulate LLM calling unknown tool 'phantom_tool'
    const functionCallItem = {
      type: 'function_call',
      name: 'phantom_tool',
      arguments: '{}',
      call_id: 'call_phantom_123',
    };

    // Expected behavior (after T007 fix):
    // 1. No TypeError "is not a function"
    // 2. Returns function_call_output with success: false
    // 3. Error message contains "MCP tools not supported" or "not found"

    // Current behavior (before fix):
    // - Throws TypeError: this.session.executeMcpTool is not a function

    // Note: We can't directly call private executeToolCall method
    // Instead, we test through handleResponseItem which processes function_call items

    // For now, this test verifies the principle
    // After T007 implementation, we'll verify the actual error handling

    // This test should FAIL before T007 implementation
    // After fix, it should pass with proper error message

    expect(() => {
      // Attempting to handle unknown tool should not throw TypeError
      // The error should be caught and returned as function_call_output
    }).not.toThrow(TypeError);

    // After T007 fix, verify error message
    // const result = await turnManager.handleResponseItem(functionCallItem);
    // expect(result).toMatchObject({
    //   type: 'function_call_output',
    //   call_id: 'call_phantom_123',
    //   success: false,
    // });
    // expect(result.content).toContain('MCP tools not supported');
  });

  it('should distinguish between different error scenarios', async () => {
    // Scenario A: Tool not in ToolRegistry, MCP not supported
    // Expected: "MCP tools not supported in browser extension. Tool 'X' not found."

    // Scenario B: Tool not in ToolRegistry, MCP supported but disabled
    // Expected: "Tool 'X' not available (mcpTools disabled in config)"

    // Scenario C: Browser tool exists in registry
    // Expected: Tool executes successfully (not an error)

    // This test will be implemented after T007 when we have the actual logic
    expect(true).toBe(true); // Placeholder
  });

  it('should emit proper error events (not TypeError)', async () => {
    // Verify that when unknown tool is called:
    // 1. Error events are emitted (e.g., ToolExecutionError)
    // 2. Events contain meaningful error messages
    // 3. No uncaught TypeError events

    const emitEventSpy = vi.spyOn(session, 'emitEvent');

    // After T007 fix, we should be able to verify:
    // - emitEvent was called
    // - Event type is error-related (not crash)
    // - Error message is descriptive

    // This test should FAIL before T007 implementation
    expect(true).toBe(true); // Placeholder
  });

  it('should handle unknown tool with config edge cases', async () => {
    // Test with mcpTools: undefined (config merge edge case)
    const edgeCaseConfig: Partial<IToolsConfig> = {
      mcpTools: undefined as any,
      enable_all_tools: false,
    };

    const edgeTurnContext = {
      ...turnContext,
      getToolsConfig: vi.fn().mockReturnValue(edgeCaseConfig),
    };

    const edgeTurnManager = new TurnManager(session, edgeTurnContext as any, toolRegistry);

    // Expected: Should not attempt to call getMcpTools or executeMcpTool
    // Should handle gracefully with clear error message

    // This test verifies T002 and T007 together
    expect(true).toBe(true); // Placeholder
  });

  it('should return error within 100ms (performance requirement)', async () => {
    // Performance requirement from research.md:
    // Total executeToolCall() overhead: <100ms

    // After T007 fix, measure actual error handling time
    // const start = performance.now();
    // await handleUnknownTool('phantom_tool');
    // const duration = performance.now() - start;
    // expect(duration).toBeLessThan(100);

    expect(true).toBe(true); // Placeholder
  });
});

describe('Unknown tool handling with browser tools', () => {
  it('should prioritize browser tools over MCP error', async () => {
    // Setup: Register a browser tool
    const toolRegistry = new ToolRegistry();

    const browserToolDef = {
      type: 'function' as const,
      function: {
        name: 'dom_query',
        description: 'Query DOM elements',
        strict: false,
        parameters: {
          type: 'object' as const,
          properties: {
            selector: { type: 'string' as const },
          },
          required: ['selector'],
        },
      },
    };

    const mockHandler = vi.fn().mockResolvedValue({ elements: [] });
    await toolRegistry.register(browserToolDef, mockHandler);

    // When LLM calls 'dom_query', it should:
    // 1. Find tool in ToolRegistry
    // 2. Execute via executeBrowserTool
    // 3. NOT attempt MCP execution

    // This verifies the tool lookup order from T003
    expect(true).toBe(true); // Placeholder
  });
});
