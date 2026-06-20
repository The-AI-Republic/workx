/**
 * Verifies that createSubAgentToolRegistry always denies the sub-agent
 * management surface (sub_agent, list_sub_agents, cancel_sub_agent,
 * send_message) so a worker sub-agent cannot interfere with siblings.
 *
 * Lives in its own file because SubAgentRunner.background.test.ts vi.mocks
 * ../../ToolRegistryCloner for unrelated coverage.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../ToolRegistry';
import { createSubAgentToolRegistry } from '../../ToolRegistryCloner';
import type { SubAgentTypeConfig } from '../types';

function fnDef(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `stub for ${name}`,
      strict: false,
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
  };
}

const workerType: SubAgentTypeConfig = {
  id: 'worker',
  name: 'Worker',
  description: 'Test worker',
  systemPrompt: 'You are a worker',
};

describe('ToolRegistryCloner — sibling management tools denied for sub-agents (M1)', () => {
  it('always excludes sub_agent, list_sub_agents, cancel_sub_agent, send_message', async () => {
    const parentRegistry = new ToolRegistry();
    const stubHandler = async () => 'noop';

    for (const name of [
      'sub_agent',
      'list_sub_agents',
      'cancel_sub_agent',
      'send_message',
      'safe_tool',
      'another_safe_tool',
    ]) {
      await parentRegistry.register(fnDef(name), stubHandler);
    }

    const childRegistry = await createSubAgentToolRegistry(parentRegistry, workerType);
    const childTools = childRegistry.listTools().map((t) =>
      t.type === 'function' ? t.function.name : 'unknown',
    );

    expect(childTools).toContain('safe_tool');
    expect(childTools).toContain('another_safe_tool');
    expect(childTools).not.toContain('sub_agent');
    expect(childTools).not.toContain('list_sub_agents');
    expect(childTools).not.toContain('cancel_sub_agent');
    expect(childTools).not.toContain('send_message');
  });

  it('still applies per-type deny list on top of the default deny', async () => {
    const parentRegistry = new ToolRegistry();
    const stubHandler = async () => 'noop';

    for (const name of ['sub_agent', 'send_message', 'dangerous_tool', 'safe_tool']) {
      await parentRegistry.register(fnDef(name), stubHandler);
    }

    const typeWithExtraDeny: SubAgentTypeConfig = {
      ...workerType,
      tools: { deny: ['dangerous_tool'] },
    };

    const childRegistry = await createSubAgentToolRegistry(parentRegistry, typeWithExtraDeny);
    const childTools = childRegistry.listTools().map((t) =>
      t.type === 'function' ? t.function.name : 'unknown',
    );

    expect(childTools).toContain('safe_tool');
    expect(childTools).not.toContain('sub_agent');
    expect(childTools).not.toContain('send_message');
    expect(childTools).not.toContain('dangerous_tool');
  });
});
