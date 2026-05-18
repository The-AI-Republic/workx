// File: src/tools/ToolRegistryCloner.ts

import { ToolRegistry } from './ToolRegistry';
import type { SubAgentTypeConfig } from './AgentTool/types';
import type { PreExecuteCheck } from './ToolRegistry';

export interface ToolCloneOptions {
  /** Tools to include (allowlist). If undefined, include all tools. */
  include?: string[];
  /** Tools to exclude (denylist). Applied after include filter. */
  exclude?: string[];
}

/**
 * Clone a tool registry with optional filtering.
 * Creates a new registry with a subset of tools from the source.
 */
export async function cloneToolRegistry(
  source: ToolRegistry,
  options: ToolCloneOptions = {}
): Promise<ToolRegistry> {
  const clone = new ToolRegistry();

  for (const [name, entry] of source.entries()) {
    // Apply include filter
    if (options.include && !options.include.includes(name)) {
      continue;
    }

    // Apply exclude filter
    if (options.exclude?.includes(name)) {
      continue;
    }

    // Deep-clone the definition to prevent cross-registry mutation
    const clonedDefinition = structuredClone(entry.definition);
    await clone.register(clonedDefinition, entry.handler, entry.riskAssessor);
  }

  return clone;
}

/**
 * Convenience function for creating sub-agent tool registries.
 * Automatically excludes dangerous tools and the sub_agent management surface.
 *
 * Always-denied tools:
 * - `sub_agent` — prevents recursive nesting
 * - `list_sub_agents`, `cancel_sub_agent`, `send_message` — prevent a sub-agent
 *   from discovering or interfering with its siblings. These tools are the
 *   parent's privileged orchestration surface; children should not have them.
 */
const ALWAYS_DENIED_FOR_SUB_AGENTS = [
  'sub_agent',
  'list_sub_agents',
  'cancel_sub_agent',
  'send_message',
];

const ALWAYS_DENIED_FOR_CHILD_AGENTS = ALWAYS_DENIED_FOR_SUB_AGENTS;

export interface ChildToolRegistryPolicy {
  allow?: string[];
  deny?: string[];
  preExecuteCheck?: PreExecuteCheck;
}

export async function createChildToolRegistry(
  parentRegistry: ToolRegistry,
  policy: ChildToolRegistryPolicy = {},
  options: { childKind: 'subagent' | 'shadow_agent' },
): Promise<ToolRegistry> {
  const clone = await cloneToolRegistry(parentRegistry, {
    include: policy.allow,
    exclude: [
      ...ALWAYS_DENIED_FOR_CHILD_AGENTS,
      ...(policy.deny ?? []),
    ],
  });

  if (policy.preExecuteCheck) {
    clone.setPreExecuteCheck(policy.preExecuteCheck);
  }

  // Keep the option in the signature as an explicit call-site marker. Future
  // child kinds can diverge here without changing the public helper shape.
  void options;
  return clone;
}

export async function createSubAgentToolRegistry(
  parentRegistry: ToolRegistry,
  subAgentType: SubAgentTypeConfig
): Promise<ToolRegistry> {
  return createChildToolRegistry(
    parentRegistry,
    {
      allow: subAgentType.tools?.allow,
      deny: subAgentType.tools?.deny,
    },
    { childKind: 'subagent' },
  );
}
