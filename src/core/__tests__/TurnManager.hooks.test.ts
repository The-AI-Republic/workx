import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnManager } from '@/core/TurnManager';
import { TurnContext } from '@/core/TurnContext';
import { HookDispatcher } from '@/core/hooks/HookDispatcher';
import { HookExecutor } from '@/core/hooks/HookExecutor';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import { getToolRuntimeContext } from '@/core/hooks/toolRuntimeContext';
import type { HookInput } from '@/core/hooks/types';
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

describe('TurnManager hook runtime context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).chrome;
  });

  it('passes tab URL/domain/cwd context to PreToolUse hooks', async () => {
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 42, url: 'https://example.com/path?q=1' })),
      },
    };

    const session = {
      sessionId: 'session-1',
      getSessionId: vi.fn(() => 'session-1'),
      getTabId: vi.fn(() => 42),
      getWorkingDirectory: vi.fn(() => '/home/rich/projects/workx'),
      getToolRegistry: vi.fn(),
      getToolResultStore: vi.fn(() => undefined),
      getContentReplacementState: vi.fn(() => undefined),
      showRawAgentReasoning: vi.fn(() => false),
    };
    const modelClient = {
      supportsNativeWebSearch: () => false,
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      setReasoningSummary: vi.fn(),
      getModel: vi.fn(() => 'gpt-4'),
      getReasoningEffort: vi.fn(),
      getReasoningSummary: vi.fn(() => ({ enabled: false })),
      getModelContextWindow: vi.fn(),
    };
    const turnContext = new TurnContext(modelClient as never, {
      sessionId: 'session-1',
      toolsConfig: { enable_all_tools: true, mcpTools: false } as never,
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.setPageContextProvider(async () => ({
      tabId: 42,
      currentUrl: 'https://example.com/path?q=1',
      currentDomain: 'example.com',
    }));
    session.getToolRegistry.mockReturnValue(toolRegistry);
    await toolRegistry.register(makeTool('browser_dom'), vi.fn(async () => ({ ok: true })));

    const hookRegistry = new HookRegistry();
    const hookExecutor = new HookExecutor();
    const hookDispatcher = new HookDispatcher(hookRegistry, hookExecutor);
    let captured: HookInput | undefined;
    vi.spyOn(hookExecutor, 'execute').mockImplementation(async (_hook, input) => {
      captured = input;
      return { hookId: 'exec-1', outcome: 'success', duration: 1 };
    });
    hookRegistry.register('PreToolUse', { type: 'command', command: 'inspect' }, 'config');

    const manager = new TurnManager(session as never, turnContext, toolRegistry);
    manager.setHookDispatcher(hookDispatcher);

    await (manager as unknown as {
      executeToolCall(toolName: string, parameters: unknown, callId: string): Promise<unknown>;
    }).executeToolCall('browser_dom', { action: 'snapshot' }, 'call-1');

    expect(captured).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'browser_dom',
      tab_id: 42,
      current_url: 'https://example.com/path?q=1',
      current_domain: 'example.com',
    });
    expect(captured?.cwd).toBe('/home/rich/projects/workx');
  });

  it('degrades to optional runtime context in headless/no-tab sessions', async () => {
    const context = await getToolRuntimeContext({ getTabId: () => -1 });

    expect(context).toEqual({});
  });

  it('emits initial activity and tool progress events through the session', async () => {
    const events: any[] = [];
    const session = {
      sessionId: 'session-1',
      getSessionId: vi.fn(() => 'session-1'),
      getTabId: vi.fn(() => -1),
      getToolResultStore: vi.fn(() => undefined),
      getContentReplacementState: vi.fn(() => undefined),
      showRawAgentReasoning: vi.fn(() => false),
      emitEvent: vi.fn(async (event) => { events.push(event.msg); }),
    };
    const modelClient = {
      supportsNativeWebSearch: () => false,
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      setReasoningSummary: vi.fn(),
      getModel: vi.fn(() => 'gpt-4'),
      getReasoningEffort: vi.fn(),
      getReasoningSummary: vi.fn(() => ({ enabled: false })),
      getModelContextWindow: vi.fn(),
    };
    const turnContext = new TurnContext(modelClient as never, {
      sessionId: 'session-1',
      toolsConfig: { enable_all_tools: true, mcpTools: false } as never,
    });
    const toolRegistry = new ToolRegistry();
    await toolRegistry.register(
      makeTool('progress_tool'),
      vi.fn(async (_params, context) => {
        context.onProgress?.({
          toolUseID: context.callId ?? 'call-1',
          data: { type: 'test_progress', status: 'running' },
        });
        return { ok: true };
      }),
      {
        runtime: {
          ui: {
            getActivityDescription: () => 'Reading page data',
          },
        },
      },
    );

    const manager = new TurnManager(session as never, turnContext, toolRegistry);
    await (manager as unknown as {
      executeToolCall(toolName: string, parameters: unknown, callId: string): Promise<unknown>;
    }).executeToolCall('progress_tool', {}, 'call-1');

    const progress = events.filter((event) => event.type === 'ToolExecutionProgress');
    expect(progress.map((event) => event.data.progress_data.type)).toEqual([
      'tool_activity',
      'test_progress',
    ]);
    expect(progress[0].data.progress_data.message).toBe('Reading page data');
  });

  it('emits ordered bounded navigation and scrape progress events', async () => {
    const events: any[] = [];
    const session = {
      sessionId: 'session-1',
      getSessionId: vi.fn(() => 'session-1'),
      getTabId: vi.fn(() => -1),
      getToolResultStore: vi.fn(() => undefined),
      getContentReplacementState: vi.fn(() => undefined),
      showRawAgentReasoning: vi.fn(() => false),
      emitEvent: vi.fn(async (event) => { events.push(event.msg); }),
    };
    const modelClient = {
      supportsNativeWebSearch: () => false,
      setModel: vi.fn(),
      setReasoningEffort: vi.fn(),
      setReasoningSummary: vi.fn(),
      getModel: vi.fn(() => 'gpt-4'),
      getReasoningEffort: vi.fn(),
      getReasoningSummary: vi.fn(() => ({ enabled: false })),
      getModelContextWindow: vi.fn(),
    };
    const turnContext = new TurnContext(modelClient as never, {
      sessionId: 'session-1',
      toolsConfig: { enable_all_tools: true, mcpTools: false } as never,
    });
    const toolRegistry = new ToolRegistry();
    await toolRegistry.register(
      makeTool('browser_navigation'),
      vi.fn(async (_params, context) => {
        context.onProgress?.({
          toolUseID: context.callId ?? 'nav-call',
          data: { type: 'navigation_progress', url: 'https://example.com', status: 'loading' },
        });
        context.onProgress?.({
          toolUseID: context.callId ?? 'nav-call',
          data: { type: 'navigation_progress', url: 'https://example.com', status: 'loaded' },
        });
        return { url: 'https://example.com', status: 'complete' };
      }),
      {
        runtime: {
          ui: {
            getActivityDescription: () => 'Navigating',
          },
        },
      },
    );
    await toolRegistry.register(
      makeTool('web_scraping'),
      vi.fn(async (_params, context) => {
        context.onProgress?.({
          toolUseID: context.callId ?? 'scrape-call',
          data: { type: 'scraping_progress', contentType: 'page', bytesExtracted: 0, status: 'started' },
        });
        context.onProgress?.({
          toolUseID: context.callId ?? 'scrape-call',
          data: { type: 'scraping_progress', contentType: 'page', bytesExtracted: 42, status: 'completed' },
        });
        return { data: { title: 'Example' } };
      }),
      {
        runtime: {
          ui: {
            getActivityDescription: () => 'Scraping page',
          },
        },
      },
    );

    const manager = new TurnManager(session as never, turnContext, toolRegistry);
    await (manager as unknown as {
      executeToolCall(toolName: string, parameters: unknown, callId: string): Promise<unknown>;
    }).executeToolCall('browser_navigation', {}, 'nav-call');
    await (manager as unknown as {
      executeToolCall(toolName: string, parameters: unknown, callId: string): Promise<unknown>;
    }).executeToolCall('web_scraping', {}, 'scrape-call');

    const progress = events.filter((event) => event.type === 'ToolExecutionProgress');
    expect(progress).toHaveLength(6);
    expect(progress.map((event) => event.data.progress_data.type)).toEqual([
      'tool_activity',
      'navigation_progress',
      'navigation_progress',
      'tool_activity',
      'scraping_progress',
      'scraping_progress',
    ]);
    expect(progress.map((event) => event.data.call_id)).toEqual([
      'nav-call',
      'nav-call',
      'nav-call',
      'scrape-call',
      'scrape-call',
      'scrape-call',
    ]);
  });
});
