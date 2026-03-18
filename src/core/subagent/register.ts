// File: src/core/subagent/register.ts

import type { RepublicAgentEngine } from '../engine/RepublicAgentEngine';
import { SubAgentRunner } from './SubAgentRunner';
import { SubAgentRegistry } from './SubAgentRegistry';
import { buildSubAgentToolDefinition } from './SubAgentTool';
import { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
import type { SubAgentTypeConfig, SubAgentToolParams } from './types';

export interface RegisterSubAgentOptions {
  /** Sub-agent types to register. Defaults to built-in types. */
  types?: SubAgentTypeConfig[];
  /** Max concurrent sub-agents. Default: 3 */
  maxConcurrent?: number;
}

/**
 * Register the sub_agent tool with a RepublicAgentEngine.
 * This wires up the tool definition, runner, and registry.
 */
export async function registerSubAgentTool(
  engine: RepublicAgentEngine,
  options: RegisterSubAgentOptions = {}
): Promise<SubAgentRunner> {
  const types = options.types ?? BUILTIN_SUBAGENT_TYPES;
  const registry = new SubAgentRegistry({
    maxConcurrent: options.maxConcurrent ?? 3,
  });

  const runner = new SubAgentRunner({
    parentEngine: engine,
    registry,
    customTypes: types,
  });

  // Build tool definition
  const toolDefinition = buildSubAgentToolDefinition(types);

  // Register the tool in the engine's registry
  const toolRegistry = engine.getToolRegistry();
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

      const toolParams: SubAgentToolParams = {
        type: params.type,
        prompt: params.prompt,
        description: typeof params.description === 'string' ? params.description : undefined,
        background: typeof params.background === 'boolean' ? params.background : undefined,
      };

      const result = await runner.run(toolParams);
      return JSON.stringify(result);
    }
  );

  return runner;
}
