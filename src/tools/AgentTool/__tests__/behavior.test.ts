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

describe('normalizeSubAgentTypeConfig context-mode defaults', () => {
  it('inherits the agentType profile modes when context fields are omitted', () => {
    // Regression: previously hardcoded [Isolated], so a worker config that
    // omitted allowedContextModes was silently locked out of fork even
    // though the Worker profile allows it.
    const normalized = typeConfig({ agentType: AgentType.Worker });
    expect(normalized.allowedContextModes).toEqual([
      SubAgentContextMode.Isolated,
      SubAgentContextMode.Fork,
    ]);
    expect(normalized.defaultContextMode).toBe(SubAgentContextMode.Isolated);

    // And the resolved behavior must agree (single source of truth).
    const behavior = resolveSubAgentBehavior(normalized, {
      contextMode: SubAgentContextMode.Fork,
    });
    expect(behavior.contextMode).toBe(SubAgentContextMode.Fork);
  });

  it('still defaults a typeless config to isolated-only', () => {
    const normalized = typeConfig();
    expect(normalized.allowedContextModes).toEqual([SubAgentContextMode.Isolated]);
    expect(normalized.defaultContextMode).toBe(SubAgentContextMode.Isolated);
  });

  it('honors an explicit allowedContextModes over the profile and clamps the default into it', () => {
    const normalized = typeConfig({
      agentType: AgentType.Worker,
      allowedContextModes: [SubAgentContextMode.Fork],
    });
    expect(normalized.allowedContextModes).toEqual([SubAgentContextMode.Fork]);
    // Worker profile default is Isolated, which is not allowed here, so it
    // clamps to the first allowed mode rather than producing an invalid default.
    expect(normalized.defaultContextMode).toBe(SubAgentContextMode.Fork);
  });
});
