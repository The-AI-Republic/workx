// File: src/tools/ToolRegistryCloner.ts

import { ToolRegistry } from './ToolRegistry';
import type { SubAgentTypeConfig } from '../core/subagent/types';

export interface ToolCloneOptions {
  /** Tools to include (allowlist). If undefined, include all tools. */
  include?: string[];
  /** Tools to exclude (denylist). Applied after include filter. */
  exclude?: string[];
  /** Default risk level for tools without assessors. */
  defaultRiskLevel?: 'low' | 'medium' | 'high';
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
 * Automatically excludes dangerous tools and the sub_agent tool itself.
 */
export async function createSubAgentToolRegistry(
  parentRegistry: ToolRegistry,
  subAgentType: SubAgentTypeConfig
): Promise<ToolRegistry> {
  const defaultDenyList = ['sub_agent']; // Always prevent nesting

  return cloneToolRegistry(parentRegistry, {
    include: subAgentType.tools?.allow,
    exclude: [
      ...defaultDenyList,
      ...(subAgentType.tools?.deny ?? []),
    ],
    defaultRiskLevel: 'low',
  });
}
