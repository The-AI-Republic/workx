import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerSkillScopedHooks } from '@/core/skills/registerSkillScopedHooks';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import { SessionHookStore } from '@/core/hooks/loaders/SessionHookStore';
import type { HooksConfig } from '@/core/hooks/types';

describe('registerSkillScopedHooks', () => {
  let registry: HookRegistry;
  let store: SessionHookStore;

  beforeEach(() => {
    registry = new HookRegistry();
    store = new SessionHookStore(registry);
  });

  it('registers each hook through the store', () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        { matcher: 'a', hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'y' }] },
      ],
      PostToolUse: [
        { matcher: 'b', hooks: [{ type: 'command', command: 'z' }] },
      ],
    };
    const count = registerSkillScopedHooks(store, hooks, 'test-skill');
    expect(count).toBe(3);
    expect(store.size).toBe(3);
    expect(registry.getMatchingHooks('PreToolUse', 'a').length).toBe(2);
    expect(registry.getMatchingHooks('PostToolUse', 'b').length).toBe(1);
  });

  it('store.clear() removes all skill-scoped hooks', () => {
    const hooks: HooksConfig = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
    };
    registerSkillScopedHooks(store, hooks, 's');
    expect(store.size).toBe(1);
    const removed = store.clear();
    expect(removed).toBe(1);
    expect(registry.getMatchingHooks('PreToolUse').length).toBe(0);
  });

  it('skips unknown event names with a warning', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hooks = {
      Bogus: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'y' }] }],
    } as unknown as HooksConfig;
    const count = registerSkillScopedHooks(store, hooks, 'test-skill');
    expect(count).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Bogus'));
    consoleSpy.mockRestore();
  });

  it('handles empty hooks config', () => {
    expect(registerSkillScopedHooks(store, {}, 'test-skill')).toBe(0);
    expect(store.size).toBe(0);
  });
});
