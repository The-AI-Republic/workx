import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import { ConfigHookLoader } from '@/core/hooks/loaders/ConfigHookLoader';
import { SessionHookStore } from '@/core/hooks/loaders/SessionHookStore';
import type { HookConfigSource } from '@/core/hooks/loaders/ConfigHookLoader';
import type { HooksConfig } from '@/core/hooks/types';

describe('ConfigHookLoader', () => {
  let registry: HookRegistry;

  const hooksConfig: HooksConfig = {
    PreToolUse: [
      { matcher: 'browser_dom', hooks: [{ type: 'command', command: 'echo pre' }] },
    ],
    PostToolUse: [
      { hooks: [{ type: 'http', url: 'https://hooks.example.com' }] },
    ],
  };

  function makeConfig(hooks?: HooksConfig): HookConfigSource {
    return {
      getConfig: () => ({ hooks }),
      on: vi.fn(),
      off: vi.fn(),
    };
  }

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('loads hooks from config', () => {
    const config = makeConfig(hooksConfig);
    ConfigHookLoader.load(config, registry);
    expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);
    expect(registry.getMatchingHooks('PostToolUse')).toHaveLength(1);
  });

  it('clears previous config hooks before loading', () => {
    const config = makeConfig(hooksConfig);
    ConfigHookLoader.load(config, registry);
    ConfigHookLoader.load(config, registry);
    // Should still be 1 per event, not doubled
    expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);
  });

  it('handles missing hooks config', () => {
    const config = makeConfig(undefined);
    ConfigHookLoader.load(config, registry);
    expect(registry.hasHooksFor('PreToolUse')).toBe(false);
  });

  it('does not clear session hooks when reloading config', () => {
    registry.register('PreToolUse', { type: 'command', command: 'session cmd' }, 'session');
    ConfigHookLoader.load(makeConfig(hooksConfig), registry);
    // Session hook still there, plus config hook
    expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(2);
  });

  describe('watch', () => {
    it('subscribes to config-changed and reloads on hooks section', () => {
      const config = makeConfig(hooksConfig);
      const unsub = ConfigHookLoader.watch(config, registry);

      expect(config.on).toHaveBeenCalledWith('config-changed', expect.any(Function));

      // Simulate hooks config change
      const handler = (config.on as any).mock.calls[0][1];
      handler({ section: 'hooks' });
      expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);

      // Unsubscribe
      unsub();
      expect(config.off).toHaveBeenCalled();
    });

    it('ignores non-hooks config changes', () => {
      const config = makeConfig(undefined);
      ConfigHookLoader.watch(config, registry);
      const handler = (config.on as any).mock.calls[0][1];
      handler({ section: 'model' });
      expect(registry.hasHooksFor('PreToolUse')).toBe(false);
    });
  });
});

describe('SessionHookStore', () => {
  let registry: HookRegistry;
  let store: SessionHookStore;

  beforeEach(() => {
    registry = new HookRegistry();
    store = new SessionHookStore(registry);
  });

  it('adds a session hook', () => {
    const id = store.add('PreToolUse', { type: 'command', command: 'echo' });
    expect(id).toBeDefined();
    expect(store.size).toBe(1);
    expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(1);
  });

  it('removes a session hook', () => {
    const id = store.add('PreToolUse', { type: 'command', command: 'echo' });
    expect(store.remove(id)).toBe(true);
    expect(store.size).toBe(0);
    expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(0);
  });

  it('returns false when removing non-existent hook', () => {
    expect(store.remove('nonexistent')).toBe(false);
  });

  it('clears all session hooks', () => {
    store.add('PreToolUse', { type: 'command', command: 'a' });
    store.add('PostToolUse', { type: 'command', command: 'b' });
    expect(store.clear()).toBe(2);
    expect(store.size).toBe(0);
  });

  it('does not affect non-session hooks when clearing', () => {
    registry.register('PreToolUse', { type: 'command', command: 'config cmd' }, 'config');
    store.add('PreToolUse', { type: 'command', command: 'session cmd' });
    store.clear();
    // Config hook should remain
    expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(1);
  });
});
