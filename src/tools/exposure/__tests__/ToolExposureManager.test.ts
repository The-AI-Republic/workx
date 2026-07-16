import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../BaseTool';
import { ToolExposureManager } from '../ToolExposureManager';
import { ToolSelectionStore } from '../ToolSelectionStore';
import type { ToolRegistryExposureEntry } from '../ToolExposureTypes';

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

describe('ToolExposureManager', () => {
  it('keeps built-ins visible while deferring MCP/A2A/plugin tools', () => {
    const store = new ToolSelectionStore();
    const manager = new ToolExposureManager(store);
    const entries: ToolRegistryExposureEntry[] = [
      { name: 'browser_navigate', definition: tool('browser_navigate') },
      { name: 'tool_search', definition: tool('tool_search'), exposure: { mode: 'always' } },
      { name: 'github__create_issue', definition: tool('github__create_issue'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' } },
      { name: 'research__summarize', definition: tool('research__summarize'), exposure: { source: 'a2a', mode: 'deferred', serverName: 'research' } },
      { name: 'plugin__deploy', definition: tool('plugin__deploy'), exposure: { source: 'plugin' } },
    ];

    const result = manager.buildExposure({
      entries,
      toolsConfig: { dynamicToolLoading: true, mcpTools: true },
      sessionId: 's1',
    } as never);

    expect(result.tools.map((t) => t.type === 'function' ? t.function.name : t.type)).toEqual([
      'browser_navigate',
      'tool_search',
    ]);
    expect(result.deferred.map((d) => d.name)).toEqual([
      'github__create_issue',
      'research__summarize',
      'plugin__deploy',
    ]);
  });

  it('hydrates selected deferred tools and drops disabled selections', () => {
    const store = new ToolSelectionStore();
    const manager = new ToolExposureManager(store);
    store.select({ sessionId: 's1' }, ['github__create_issue', 'github__delete_repo']);
    const entries: ToolRegistryExposureEntry[] = [
      { name: 'browser_navigate', definition: tool('browser_navigate') },
      { name: 'tool_search', definition: tool('tool_search'), exposure: { mode: 'always' } },
      { name: 'github__create_issue', definition: tool('github__create_issue'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' } },
      { name: 'github__delete_repo', definition: tool('github__delete_repo'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' } },
    ];

    const result = manager.buildExposure({
      entries,
      toolsConfig: {
        dynamicToolLoading: true,
        mcpTools: true,
        disabled: ['github__delete_repo'],
      },
      sessionId: 's1',
    } as never);

    expect(result.tools.map((t) => t.type === 'function' ? t.function.name : t.type)).toEqual([
      'browser_navigate',
      'tool_search',
      'github__create_issue',
    ]);
    expect(result.hidden.map((d) => d.name)).toContain('github__delete_repo');
  });

  it('does not expose or search MCP tools when MCP tools are disabled', () => {
    const manager = new ToolExposureManager(new ToolSelectionStore());
    const result = manager.buildExposure({
      entries: [
        { name: 'browser_navigate', definition: tool('browser_navigate') },
        { name: 'github__create_issue', definition: tool('github__create_issue'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' } },
      ],
      toolsConfig: { dynamicToolLoading: true, mcpTools: false },
      sessionId: 's1',
    } as never);

    expect(result.tools.map((t) => t.type === 'function' ? t.function.name : t.type)).toEqual(['browser_navigate']);
    expect(result.hidden.map((d) => d.name)).toEqual(['github__create_issue']);
    expect(result.deferred).toEqual([]);
  });

  it('exposes builtin (AI Hub gateway) MCP tools even when mcpTools is off', () => {
    const manager = new ToolExposureManager(new ToolSelectionStore());
    const result = manager.buildExposure({
      entries: [
        // user-added MCP server tool: gated off
        { name: 'github__create_issue', definition: tool('github__create_issue'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'github' } },
        // builtin gateway tool: exempt from the mcpTools toggle
        { name: 'openhub__github__get_me', definition: tool('openhub__github__get_me'), exposure: { source: 'mcp', mode: 'deferred', serverName: 'openhub', builtin: true } },
      ],
      toolsConfig: { dynamicToolLoading: true, mcpTools: false },
      sessionId: 's1',
    } as never);

    // The user MCP tool stays hidden; the builtin gateway tool is available
    // (deferred, discoverable) despite mcpTools being false.
    expect(result.hidden.map((d) => d.name)).toEqual(['github__create_issue']);
    expect(result.deferred.map((d) => d.name)).toContain('openhub__github__get_me');
  });
});
