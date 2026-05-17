import { describe, expect, it } from 'vitest';
import { AgentType, SubAgentContextMode, SubAgentExecutionMode } from '../agentTypes';
import { resolveSubAgentBehavior } from '../behavior';
import type { SubAgentTypeConfig } from '../types';
import { normalizeSubAgentTypeConfig } from '../validateTypeConfig';

function typeConfig(overrides: Partial<SubAgentTypeConfig> = {}): SubAgentTypeConfig {
  return normalizeSubAgentTypeConfig({
    id: 'test',
    name: 'Test',
    description: 'Test agent',
    systemPrompt: 'Test prompt',
    ...overrides,
  });
}

describe('resolveSubAgentBehavior', () => {
  it('defaults config agents to general-purpose isolated foreground behavior', () => {
    const behavior = resolveSubAgentBehavior(typeConfig(), {});
    expect(behavior.agentType).toBe(AgentType.GeneralPurpose);
    expect(behavior.contextMode).toBe(SubAgentContextMode.Isolated);
    expect(behavior.executionMode).toBe(SubAgentExecutionMode.Foreground);
  });

  it('resolves fork background mode when the type allows it', () => {
    const behavior = resolveSubAgentBehavior(
      typeConfig({
        agentType: AgentType.Worker,
        allowedContextModes: [SubAgentContextMode.Isolated, SubAgentContextMode.Fork],
      }),
      { background: true, contextMode: SubAgentContextMode.Fork },
    );

    expect(behavior.agentType).toBe(AgentType.Worker);
    expect(behavior.contextMode).toBe(SubAgentContextMode.Fork);
    expect(behavior.executionMode).toBe(SubAgentExecutionMode.Background);
    expect(behavior.canUseParentHistory).toBe(true);
  });

  it('rejects disallowed context mode', () => {
    expect(() =>
      resolveSubAgentBehavior(typeConfig(), { contextMode: SubAgentContextMode.Fork }),
    ).toThrow(/does not allow context mode/);
  });
});
