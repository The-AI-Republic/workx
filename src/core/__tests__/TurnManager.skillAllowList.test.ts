import { describe, expect, it, vi } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { TurnContext } from '@/core/TurnContext';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition } from '@/tools/BaseTool';

function makeTool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
    },
  };
}

function makeManager() {
  const session = {
    getSessionId: vi.fn(() => 'session-1'),
    emitEvent: vi.fn(),
    getMcpTools: vi.fn(async () => []),
    executeMcpTool: vi.fn(),
    recordTurnContext: vi.fn(),
  };
  const modelClient = {
    supportsNativeWebSearch: () => false,
    setModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    setReasoningSummary: vi.fn(),
  };
  const turnContext = new TurnContext(modelClient as never, {
    sessionId: 'session-1',
    toolsConfig: {
      enable_all_tools: false,
      webSearch: false,
      mcpTools: false,
    } as never,
  });
  const toolRegistry = new ToolRegistry();
  const turnManager = new TurnManager(session as never, turnContext, toolRegistry);
  return { turnManager, turnContext, toolRegistry };
}

describe('TurnManager skill allowed-tools gate', () => {
  it('filters the model-visible tool list to the active skill allow-list', async () => {
    const { turnManager, turnContext, toolRegistry } = makeManager();
    await toolRegistry.register(makeTool('read_dom'), vi.fn());
    await toolRegistry.register(makeTool('click_dom'), vi.fn());

    turnContext.setActiveToolAllowList(['read_dom']);
    const tools = await (turnManager as unknown as {
      buildToolsFromContext(): Promise<ToolDefinition[]>;
    }).buildToolsFromContext();

    expect(tools.map((tool) => tool.type === 'function' ? tool.function.name : tool.type)).toEqual(['read_dom']);
  });

  it('hard-denies dispatch for a tool outside the active skill allow-list', async () => {
    const { turnManager, turnContext, toolRegistry } = makeManager();
    const handler = vi.fn(async () => ({ ok: true }));
    await toolRegistry.register(makeTool('click_dom'), handler);
    turnContext.setActiveToolAllowList(['read_dom']);

    const result = await (turnManager as unknown as {
      executeToolCall(toolName: string, parameters: unknown, callId: string): Promise<{ output: string }>;
    }).executeToolCall('click_dom', {}, 'call-1');

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toEqual({
      error: {
        code: 'SKILL_TOOL_NOT_ALLOWED',
        message: 'Tool "click_dom" is not allowed by the active skill allowed-tools list',
        allowedTools: 'read_dom',
      },
    });
  });
});
