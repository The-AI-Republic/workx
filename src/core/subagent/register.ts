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
  const customTypes = options.types;
  const registry = new SubAgentRegistry({
    maxConcurrent: options.maxConcurrent ?? 3,
  });

  const runner = new SubAgentRunner({
    parentEngine: engine,
    registry,
    customTypes,
  });

  // Build tool definition with all types (builtins + custom) to match
  // what the runner actually accepts at runtime
  const allTypes = mergeTypes(customTypes);
  const toolDefinition = buildSubAgentToolDefinition(allTypes);

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
      };

      const result = await runner.run(toolParams);
      return JSON.stringify(result);
    }
  );

  return runner;
}

/**
 * Merge builtins with optional custom types.
 * Custom types with the same ID override builtins.
 */
function mergeTypes(customTypes?: SubAgentTypeConfig[]): SubAgentTypeConfig[] {
  const merged = new Map<string, SubAgentTypeConfig>();
  for (const t of BUILTIN_SUBAGENT_TYPES) {
    merged.set(t.id, t);
  }
  if (customTypes) {
    for (const t of customTypes) {
      merged.set(t.id, t);
    }
  }
  return Array.from(merged.values());
}
