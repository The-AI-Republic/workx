/**
 * Tests for ToolRegistryCloner
 *
 * Covers cloneToolRegistry and createSubAgentToolRegistry functions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition, ToolHandler } from '@/tools/BaseTool';
import type { IRiskAssessor } from '@/core/approval/types';
import type { SubAgentTypeConfig } from '@/core/subagent/types';
import {
  cloneToolRegistry,
  createSubAgentToolRegistry,
} from '@/tools/ToolRegistryCloner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFunctionTool(name: string): ToolDefinition {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `Tool ${name}`,
      strict: false,
      parameters: {
        type: 'object' as const,
        properties: {
          input: { type: 'string' as const, description: 'an input' },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  };
}

function noopHandler(): ToolHandler {
  return vi.fn().mockResolvedValue({ ok: true });
}

function makeFakeRiskAssessor(): IRiskAssessor {
  return {
    assess: vi.fn().mockReturnValue({ level: 'low', reason: 'test' }),
  };
}

function makeSubAgentConfig(
  overrides: Partial<SubAgentTypeConfig> = {},
): SubAgentTypeConfig {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test sub-agent',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

/**
 * Register a set of named tools onto a registry and return the handlers/assessors
 * so tests can reference them later.
 */
async function seedRegistry(
  registry: ToolRegistry,
  names: string[],
  options?: { withRiskAssessor?: boolean },
): Promise<{
  handlers: Map<string, ToolHandler>;
  assessors: Map<string, IRiskAssessor>;
}> {
  const handlers = new Map<string, ToolHandler>();
  const assessors = new Map<string, IRiskAssessor>();

  for (const name of names) {
    const handler = noopHandler();
    handlers.set(name, handler);

    let assessor: IRiskAssessor | undefined;
    if (options?.withRiskAssessor) {
      assessor = makeFakeRiskAssessor();
      assessors.set(name, assessor);
    }

    await registry.register(makeFunctionTool(name), handler, assessor);
  }

  return { handlers, assessors };
}

/** Collect tool names from a registry into a sorted array for easy assertion. */
function toolNames(registry: ToolRegistry): string[] {
  return Array.from(registry.entries())
    .map(([name]) => name)
    .sort();
}

// ---------------------------------------------------------------------------
// cloneToolRegistry
// ---------------------------------------------------------------------------

describe('cloneToolRegistry', () => {
  let source: ToolRegistry;

  beforeEach(() => {
    source = new ToolRegistry();
  });

  // 1. Clones all tools when no filters given
  it('clones all tools when no filters given', async () => {
    await seedRegistry(source, ['alpha', 'beta', 'gamma']);

    const clone = await cloneToolRegistry(source);

    expect(toolNames(clone)).toEqual(['alpha', 'beta', 'gamma']);
  });

  // 2. Applies include filter (only listed tools)
  it('applies include filter (only listed tools)', async () => {
    await seedRegistry(source, ['alpha', 'beta', 'gamma']);

    const clone = await cloneToolRegistry(source, {
      include: ['alpha', 'gamma'],
    });

    expect(toolNames(clone)).toEqual(['alpha', 'gamma']);
  });

  // 3. Applies exclude filter (removes listed tools)
  it('applies exclude filter (removes listed tools)', async () => {
    await seedRegistry(source, ['alpha', 'beta', 'gamma']);

    const clone = await cloneToolRegistry(source, {
      exclude: ['beta'],
    });

    expect(toolNames(clone)).toEqual(['alpha', 'gamma']);
  });

  // 4. Applies include then exclude (combined)
  it('applies include then exclude (combined)', async () => {
    await seedRegistry(source, ['alpha', 'beta', 'gamma', 'delta']);

    const clone = await cloneToolRegistry(source, {
      include: ['alpha', 'beta', 'gamma'],
      exclude: ['beta'],
    });

    expect(toolNames(clone)).toEqual(['alpha', 'gamma']);
  });

  // 5. Deep clones definitions (structuredClone) - mutating clone doesn't affect source
  it('deep clones definitions so mutating clone does not affect source', async () => {
    await seedRegistry(source, ['alpha']);

    const clone = await cloneToolRegistry(source);

    // Grab the definition from the clone and mutate it
    const clonedEntry = Array.from(clone.entries()).find(
      ([n]) => n === 'alpha',
    )!;
    const clonedDef = clonedEntry[1].definition;
    expect(clonedDef.type).toBe('function');
    if (clonedDef.type === 'function') {
      clonedDef.function.description = 'MUTATED';
    }

    // Source definition must be unchanged
    const sourceEntry = Array.from(source.entries()).find(
      ([n]) => n === 'alpha',
    )!;
    const sourceDef = sourceEntry[1].definition;
    expect(sourceDef.type).toBe('function');
    if (sourceDef.type === 'function') {
      expect(sourceDef.function.description).toBe('Tool alpha');
    }
  });

  // 6. Preserves handler functions
  it('preserves handler functions', async () => {
    const { handlers } = await seedRegistry(source, ['alpha', 'beta']);

    const clone = await cloneToolRegistry(source);

    for (const [name, entry] of clone.entries()) {
      expect(entry.handler).toBe(handlers.get(name));
    }
  });

  // 7. Preserves riskAssessor
  it('preserves riskAssessor', async () => {
    const { assessors } = await seedRegistry(source, ['alpha', 'beta'], {
      withRiskAssessor: true,
    });

    const clone = await cloneToolRegistry(source);

    for (const [name, entry] of clone.entries()) {
      expect(entry.riskAssessor).toBe(assessors.get(name));
    }
  });

  // 8. Handles empty source registry
  it('handles empty source registry', async () => {
    const clone = await cloneToolRegistry(source);

    expect(toolNames(clone)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createSubAgentToolRegistry
// ---------------------------------------------------------------------------

describe('createSubAgentToolRegistry', () => {
  let parent: ToolRegistry;

  beforeEach(() => {
    parent = new ToolRegistry();
  });

  // 9. Always excludes 'sub_agent' tool
  it('always excludes sub_agent tool', async () => {
    await seedRegistry(parent, ['alpha', 'sub_agent', 'beta']);

    const config = makeSubAgentConfig();
    const registry = await createSubAgentToolRegistry(parent, config);

    expect(toolNames(registry)).toEqual(['alpha', 'beta']);
  });

  // 10. Respects SubAgentTypeConfig tools.deny
  it('respects SubAgentTypeConfig tools.deny', async () => {
    await seedRegistry(parent, ['alpha', 'beta', 'gamma', 'sub_agent']);

    const config = makeSubAgentConfig({
      tools: { deny: ['gamma'] },
    });
    const registry = await createSubAgentToolRegistry(parent, config);

    // sub_agent and gamma should both be excluded
    expect(toolNames(registry)).toEqual(['alpha', 'beta']);
  });

  // 11. Respects SubAgentTypeConfig tools.allow
  it('respects SubAgentTypeConfig tools.allow', async () => {
    await seedRegistry(parent, [
      'alpha',
      'beta',
      'gamma',
      'sub_agent',
    ]);

    const config = makeSubAgentConfig({
      tools: { allow: ['alpha', 'beta', 'sub_agent'] },
    });
    const registry = await createSubAgentToolRegistry(parent, config);

    // sub_agent is in allow but always denied; only alpha and beta remain
    expect(toolNames(registry)).toEqual(['alpha', 'beta']);
  });

  // 12. Works with no tools config (includes all except sub_agent)
  it('works with no tools config (includes all except sub_agent)', async () => {
    await seedRegistry(parent, ['alpha', 'beta', 'sub_agent']);

    const config = makeSubAgentConfig(); // no tools field
    const registry = await createSubAgentToolRegistry(parent, config);

    expect(toolNames(registry)).toEqual(['alpha', 'beta']);
  });
});
