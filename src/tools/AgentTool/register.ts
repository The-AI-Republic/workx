// File: src/tools/AgentTool/register.ts

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import { SubAgentRunner } from './SubAgentRunner';
import { SubAgentRegistry } from './SubAgentRegistry';
import { buildSubAgentToolDefinition } from './SubAgentTool';
import { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
import {
  buildListSubAgentsToolDefinition,
  buildCancelSubAgentToolDefinition,
  buildSendMessageToolDefinition,
  createListSubAgentsHandler,
  createCancelSubAgentHandler,
  createSendMessageHandler,
} from './managementTools';
import type { SubAgentTypeConfig, SubAgentToolParams } from './types';
import {
  normalizeSubAgentTypeConfig,
  validateSubAgentTypeConfig,
} from './validateTypeConfig';
import { isSubAgentContextMode } from './agentTypes';

export interface RegisterSubAgentOptions {
  /** Sub-agent types to register. Defaults to built-in types. */
  types?: SubAgentTypeConfig[];
  /** Max concurrent sub-agents. Default: 3 */
  maxConcurrent?: number;
}

/**
 * Register the sub_agent tool (and management tools) with a RepublicAgentEngine.
 * This wires up the tool definition, runner, and registry.
 */
export async function registerSubAgentTool(
  engine: RepublicAgentEngine,
  options: RegisterSubAgentOptions = {}
): Promise<SubAgentRunner> {
  const customTypes = options.types;
  const registry = new SubAgentRegistry({
    maxConcurrent: options.maxConcurrent ?? 3,
    onError: (msg, error) => {
      engine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            error: `${msg}: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
      });
    },
  });

  // Phase 4: Load sub-agent types from config (optional)
  let configTypes: SubAgentTypeConfig[] = [];
  try {
    const agentConfig = engine.getConfig().agentConfig;
    const configData = agentConfig.getConfig();
    const rawTypes = (configData as unknown as Record<string, unknown>).subAgentTypes;
    if (Array.isArray(rawTypes)) {
      configTypes = [];
      for (const raw of rawTypes) {
        if (!validateSubAgentTypeConfig(raw)) continue;
        try {
          configTypes.push(normalizeSubAgentTypeConfig(raw));
        } catch (error) {
          console.warn(
            `[SubAgent type config] ${raw.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch {
    // Config loading is optional
  }

  const runner = new SubAgentRunner({
    parentEngine: engine,
    registry,
    customTypes: [...configTypes, ...(customTypes ?? [])],
  });

  // Build tool definition with all types (builtins + config + custom) to match
  // what the runner actually accepts at runtime
  const allTypes = mergeTypes(configTypes, customTypes);
  const toolDefinition = buildSubAgentToolDefinition(allTypes);

  // Register tools in the engine's registry
  const toolRegistry = engine.getToolRegistry();

  // Register the main sub_agent tool
  await toolRegistry.register(
    toolDefinition,
    async (params: Record<string, unknown>, _context: unknown) => {
      // Validate required parameters
      if (typeof params.type !== 'string' || !params.type) {
        return JSON.stringify({ success: false, error: 'Missing required parameter: type' });
      }
      if (typeof params.prompt !== 'string' || !params.prompt) {
        return JSON.stringify({ success: false, error: 'Missing required parameter: prompt' });
      }

      // Accept both the tool-schema snake_case `context_mode` and the
      // internal camelCase `contextMode`. When a value is supplied but
      // unrecognized, fail loudly instead of silently defaulting — this
      // matches resolveSubAgentBehavior, which throws for a valid-but-
      // disallowed mode rather than coercing it.
      const rawContextMode = params.context_mode ?? params.contextMode;
      let contextMode: SubAgentToolParams['contextMode'];
      if (rawContextMode !== undefined) {
        if (!isSubAgentContextMode(rawContextMode)) {
          return JSON.stringify({
            success: false,
            error: `Invalid context_mode '${String(rawContextMode)}'. Expected 'isolated' or 'fork'.`,
          });
        }
        contextMode = rawContextMode;
      }

      const toolParams: SubAgentToolParams = {
        type: params.type,
        prompt: params.prompt,
        description: typeof params.description === 'string' ? params.description : undefined,
        background: params.background === true,
        contextMode,
      };

      const result = await runner.run(toolParams);
      return JSON.stringify(result);
    }
  );

  // Register management tools (list, cancel, send_message)
  await toolRegistry.register(
    buildListSubAgentsToolDefinition(),
    createListSubAgentsHandler(registry),
  );

  await toolRegistry.register(
    buildCancelSubAgentToolDefinition(),
    createCancelSubAgentHandler(registry),
  );

  await toolRegistry.register(
    buildSendMessageToolDefinition(),
    createSendMessageHandler(registry),
  );

  return runner;
}

/**
 * Merge builtins with optional config types and custom types.
 * Later layers override earlier ones (builtins < config < custom).
 */
function mergeTypes(
  configTypes?: SubAgentTypeConfig[],
  customTypes?: SubAgentTypeConfig[],
): SubAgentTypeConfig[] {
  const merged = new Map<string, SubAgentTypeConfig>();
  for (const t of BUILTIN_SUBAGENT_TYPES) {
    merged.set(t.id, t);
  }
  if (configTypes) {
    for (const t of configTypes) {
      merged.set(t.id, t);
    }
  }
  if (customTypes) {
    for (const t of customTypes) {
      merged.set(t.id, t);
    }
  }
  return Array.from(merged.values());
}

// Track 10: validateSubAgentTypeConfig moved to ./validateTypeConfig.ts
// (re-exported here for backwards compatibility with external callers).
export { validateSubAgentTypeConfig };
