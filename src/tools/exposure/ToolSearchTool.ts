import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition, ToolHandler } from '../BaseTool';
import type { ToolRegistry } from '../ToolRegistry';
import type { ToolExposureManager } from './ToolExposureManager';
import { ToolSearchIndex } from './ToolSearchIndex';
import type { ToolSelectionStore } from './ToolSelectionStore';

export const TOOL_SEARCH_NAME = 'tool_search';

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_SEARCH_NAME,
    description: 'Search available deferred tools and select tools to make available on the next model request.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tool search query, for example "github issue", "+github issue", or "mcp:github".' },
        max_results: { type: 'integer', description: 'Maximum number of matches to return.' },
        select: {
          type: 'array',
          description: 'Exact deferred tool names to select for the next model request.',
          items: { type: 'string' },
        },
      },
      required: ['query'],
    },
  },
};

export interface ToolSearchHandlerDeps {
  registry: ToolRegistry;
  exposureManager: ToolExposureManager;
  selectionStore: ToolSelectionStore;
  getToolsConfig: () => IToolsConfig;
  getSessionId: () => string;
  getTaskId?: () => string | undefined;
  getModelContextWindow?: () => number | undefined;
  isToolAllowed?: (name: string) => boolean;
}

export function createToolSearchHandler(deps: ToolSearchHandlerDeps): ToolHandler {
  return async (params) => {
    const query = typeof params.query === 'string' ? params.query : '';
    const maxResults = typeof params.max_results === 'number' ? params.max_results : undefined;
    const select = Array.isArray(params.select)
      ? params.select.filter((item): item is string => typeof item === 'string')
      : [];
    const sessionId = deps.getSessionId();
    const taskId = deps.getTaskId?.();

    const deferred = deps.exposureManager.getSearchableDeferredTools({
      entries: deps.registry.entriesWithExposure(),
      toolsConfig: deps.getToolsConfig(),
      sessionId,
      taskId,
      modelContextWindow: deps.getModelContextWindow?.(),
      isToolAllowed: deps.isToolAllowed,
    });
    const index = new ToolSearchIndex(deferred);
    const result = index.search(query, { maxResults, select });
    const selectable = new Set(deferred.map((tool) => tool.name));
    const selected = [...new Set(result.exactSelect)].filter((name) => selectable.has(name));

    if (selected.length > 0) {
      deps.selectionStore.select({ sessionId, taskId }, selected);
    }

    return JSON.stringify({
      matches: result.matches.map(({ score, ...match }) => ({
        ...match,
        selected: match.selected || selected.includes(match.name),
      })),
      selected,
      totalDeferredTools: deferred.length,
    });
  };
}

export async function ensureToolSearchRegistered(
  registry: ToolRegistry,
  handler: ToolHandler,
): Promise<void> {
  if (registry.getTool(TOOL_SEARCH_NAME)) return;
  await registry.register(TOOL_SEARCH_DEFINITION, handler, {
    exposure: {
      mode: 'always',
      source: 'builtin',
      displayName: 'Tool Search',
      searchHint: 'search deferred tools and make them available',
    },
    runtime: {
      concurrency: {
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        isDestructive: () => false,
      },
      result: {
        maxResultSizeChars: 20_000,
      },
    },
  });
}
