import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition } from '@/tools/BaseTool';
import { ShadowAgentKind, ShadowContextPolicy } from '../types';
import { ShadowAgentRunner } from '../ShadowAgentRunner';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';

function fnDef(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      strict: false,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

describe('ShadowAgentRunner', () => {
  it('creates a child engine without sub-agent management tools', async () => {
    const registry = new ToolRegistry();
    for (const name of ['file_edit', 'sub_agent', 'list_sub_agents', 'cancel_sub_agent', 'send_message']) {
      await registry.register(fnDef(name), vi.fn());
    }

    let childConfig: any;
    const child = {
      engineId: 'child-1',
      initialize: vi.fn(),
      run: vi.fn().mockResolvedValue({
        success: true,
        response: 'done',
        tokenUsage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
      dispose: vi.fn(),
    };
    const parent = {
      engineId: 'parent-1',
      getToolRegistry: () => registry,
      getSession: () => ({
        getSessionId: () => 'session-1',
        getConversationHistory: () => ({ items: [] }),
      }),
      createChildEngine: vi.fn((config) => {
        childConfig = config;
        return child;
      }),
      pushEvent: vi.fn(),
    } as unknown as RepublicAgentEngine;

    const runner = new ShadowAgentRunner({ parentEngine: parent });
    const result = await runner.run({
      kind: ShadowAgentKind.SessionSummary,
      parentEngine: parent,
      prompt: 'update summary',
      systemPrompt: 'summary system',
      contextPolicy: ShadowContextPolicy.ParentHistory,
    });

    const childTools = childConfig.toolRegistry.listTools().map((tool: ToolDefinition) =>
      tool.type === 'function' ? tool.function.name : 'unknown',
    );
    expect(result.status).toBe('completed');
    expect(childTools).toEqual(['file_edit']);
    expect(child.run).toHaveBeenCalledWith([{ type: 'text', text: 'update summary' }], expect.anything());
    expect(child.dispose).toHaveBeenCalled();
  });

  it('marks the child engine as a shadow child so it cannot recurse into shadow compaction', async () => {
    const registry = new ToolRegistry();
    await registry.register(fnDef('file_edit'), vi.fn());

    let childConfig: any;
    const child = {
      engineId: 'child-1',
      initialize: vi.fn(),
      run: vi.fn().mockResolvedValue({
        success: true,
        response: 'done',
        tokenUsage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
      dispose: vi.fn(),
    };
    const parent = {
      engineId: 'parent-1',
      getToolRegistry: () => registry,
      getSession: () => ({
        getSessionId: () => 'session-1',
        getConversationHistory: () => ({ items: [] }),
      }),
      createChildEngine: vi.fn((config) => {
        childConfig = config;
        return child;
      }),
      pushEvent: vi.fn(),
    } as unknown as RepublicAgentEngine;

    const runner = new ShadowAgentRunner({ parentEngine: parent });
    await runner.run({
      kind: ShadowAgentKind.SessionSummary,
      parentEngine: parent,
      prompt: 'update summary',
      systemPrompt: 'summary system',
      contextPolicy: ShadowContextPolicy.ParentHistory,
    });

    expect(childConfig.isShadowAgentChild).toBe(true);
  });
});
