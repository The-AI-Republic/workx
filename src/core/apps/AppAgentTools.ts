import type { ToolDefinition } from '../../tools/BaseTool';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import { StaticRiskAssessor } from '../approval/assessors/StaticRiskAssessor';
import { AppActivationService } from './AppActivationService';
import { AppLocalStore } from './AppLocalStore';
import { AppMetadataIndex } from './AppMetadataIndex';

export interface AppAgentToolDeps {
  store?: AppLocalStore;
  index?: AppMetadataIndex;
  activation?: AppActivationService;
}

function appSearchDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'app_search',
      description: 'Search installed app metadata to find a connected app that can help with the current task. Use this before activating folded apps.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language description of the needed data source or action.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of app matches to return.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    metadata: { platforms: ['desktop'], appTool: true },
  };
}

function appActivateDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'app_activate',
      description: 'Activate an installed app for the current task by connecting its MCP server and exposing its tools.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          appId: {
            type: 'string',
            description: 'App ID returned by app_search.',
          },
        },
        required: ['appId'],
        additionalProperties: false,
      },
    },
    metadata: { platforms: ['desktop'], appTool: true },
  };
}

function appDeactivateDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'app_deactivate',
      description: 'Deactivate an installed app by disconnecting its runtime MCP server.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          appId: {
            type: 'string',
            description: 'App ID to deactivate.',
          },
        },
        required: ['appId'],
        additionalProperties: false,
      },
    },
    metadata: { platforms: ['desktop'], appTool: true },
  };
}

function appListActiveDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'app_list_active',
      description: 'List apps currently activated for MCP tool use.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    metadata: { platforms: ['desktop'], appTool: true },
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 8;
  }
  return Math.max(1, Math.min(20, Math.floor(value)));
}

export async function registerAppAgentTools(registry: ToolRegistry, deps: AppAgentToolDeps = {}): Promise<void> {
  const store = deps.store ?? new AppLocalStore();
  const index = deps.index ?? new AppMetadataIndex(store);
  const activation = deps.activation ?? new AppActivationService(store);
  const readOnlyAssessor = new StaticRiskAssessor(0);
  const stateChangeAssessor = new StaticRiskAssessor(2);

  if (!registry.getTool('app_search')) {
    await registry.register(
      appSearchDefinition(),
      async (params) => {
        const query = asString(params.query);
        return {
          results: await index.search(query, asLimit(params.limit)),
        };
      },
      {
        riskAssessor: readOnlyAssessor,
        runtime: {
          concurrency: {
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
          },
        },
      },
    );
  }

  if (!registry.getTool('app_activate')) {
    await registry.register(
      appActivateDefinition(),
      async (params) => activation.activate(asString(params.appId)),
      stateChangeAssessor,
    );
  }

  if (!registry.getTool('app_deactivate')) {
    await registry.register(
      appDeactivateDefinition(),
      async (params) => activation.deactivate(asString(params.appId)),
      stateChangeAssessor,
    );
  }

  if (!registry.getTool('app_list_active')) {
    await registry.register(
      appListActiveDefinition(),
      async () => ({ apps: await activation.listActive() }),
      {
        riskAssessor: readOnlyAssessor,
        runtime: {
          concurrency: {
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
          },
        },
      },
    );
  }
}
