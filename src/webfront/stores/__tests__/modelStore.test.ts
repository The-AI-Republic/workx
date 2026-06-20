/**
 * Unit tests for modelStore — reactive selectedModelKey backed by AgentConfig events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// AgentConfig is a Promise-returning singleton. We mock it before importing modelStore
// so initialize() resolves against our test double, not the real singleton.
// vi.hoisted runs alongside vi.mock hoisting so the mock state is defined when the
// mock factory closes over it.
type ChangeHandler = (e: { type: 'config-changed'; section: string; oldValue: unknown; newValue: unknown; timestamp: number }) => void;

const mocks = vi.hoisted(() => {
  const mockHandlers: Set<ChangeHandler> = new Set();
  const state = { mockSelectedModelKey: 'openai:gpt-4o' };
  const mockAgentConfig = {
    getConfig: () => ({ selectedModelKey: state.mockSelectedModelKey }),
    on: (_event: 'config-changed', handler: ChangeHandler) => {
      mockHandlers.add(handler);
    },
    off: (_event: 'config-changed', handler: ChangeHandler) => {
      mockHandlers.delete(handler);
    },
  };
  return { mockHandlers, mockAgentConfig, state };
});

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: async () => mocks.mockAgentConfig,
  },
}));

const { mockHandlers, state } = mocks;

import { selectedModelKey, _resetForTests } from '../modelStore';

function fireConfigEvent(section: string, newValue: unknown) {
  const event = {
    type: 'config-changed' as const,
    section,
    oldValue: null,
    newValue,
    timestamp: Date.now(),
  };
  mockHandlers.forEach((h) => h(event));
}

describe('modelStore', () => {
  beforeEach(async () => {
    mockHandlers.clear();
    state.mockSelectedModelKey ='openai:gpt-4o';
    vi.clearAllMocks();
    await _resetForTests();
  });

  it('initializes from AgentConfig.getConfig().selectedModelKey', () => {
    expect(get(selectedModelKey)).toBe('openai:gpt-4o');
  });

  it('updates when AgentConfig fires a config-changed event with section=model', () => {
    state.mockSelectedModelKey ='anthropic:claude-opus-4-7';
    fireConfigEvent('model', 'anthropic:claude-opus-4-7');

    expect(get(selectedModelKey)).toBe('anthropic:claude-opus-4-7');
  });

  it('ignores events for other config sections', () => {
    state.mockSelectedModelKey ='should-not-be-read';
    fireConfigEvent('provider', { id: 'foo' });

    // Store should still hold the original value since 'provider' is filtered out
    expect(get(selectedModelKey)).toBe('openai:gpt-4o');
  });

  it('re-reads from getConfig() rather than trusting the event payload', () => {
    // updateModelConfig emits full IModelConfig objects, not string keys.
    // The store must ignore the payload and re-read the canonical selectedModelKey.
    state.mockSelectedModelKey ='fireworks:kimi-k2';
    fireConfigEvent('model', { name: 'Kimi K2', modelKey: 'kimi-k2' } /* wrong shape on purpose */);

    expect(get(selectedModelKey)).toBe('fireworks:kimi-k2');
  });
});
