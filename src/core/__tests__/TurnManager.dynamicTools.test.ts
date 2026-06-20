import { describe, expect, it, vi } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { TurnContext } from '@/core/TurnContext';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition } from '@/tools/BaseTool';

function tool(name: string, description = name): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      strict: false,
      parameters: { type: 'object', properties: {} },
    },
  };
}

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.type === 'function' ? t.function.name : t.type);
}

describe('TurnManager dynamic tool loading', () => {
  it('initially exposes core plus tool_search, then hydrates selected deferred schemas', async () => {
    const session = {
      getSessionId: vi.fn(() => 'session-1'),
      emitEvent: vi.fn(),
      recordTurnContext: vi.fn(),
    };
    const modelClient = {
      supportsNativeWebSearch: () => false,
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      setReasoningSummary: vi.fn(),
      getModel: () => 'gpt-test',
      getModelContextWindow: () => 128000,
    };
    const turnContext = new TurnContext(modelClient as never, {
      sessionId: 'session-1',
      toolsConfig: {
        dynamicToolLoading: true,
        mcpTools: true,
        webSearch: false,
      } as never,
    });
    const registry = new ToolRegistry();
    await registry.register(tool('browser_navigate'), vi.fn(async () => 'ok'));
    await registry.register(tool('github__create_issue', 'Create a GitHub issue'), vi.fn(async () => 'ok'), {
      exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' },
    });

    const manager = new TurnManager(session as never, turnContext, registry);
    expect(names(await (manager as never as { buildToolsFromContext(): Promise<ToolDefinition[]> }).buildToolsFromContext())).toEqual([
      'browser_navigate',
      'tool_search',
    ]);
    expect(session.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.objectContaining({
        type: 'ToolExposureUpdated',
        data: expect.objectContaining({
          dynamic_enabled: true,
          deferred_count: 1,
        }),
      }),
    }));

    const searchResult = await registry.execute({
      toolName: 'tool_search',
      parameters: { query: 'github issue', select: ['github__create_issue'] },
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(searchResult.success).toBe(true);

    expect(names(await (manager as never as { buildToolsFromContext(): Promise<ToolDefinition[]> }).buildToolsFromContext())).toEqual([
      'browser_navigate',
      'tool_search',
      'github__create_issue',
    ]);
  });
});
