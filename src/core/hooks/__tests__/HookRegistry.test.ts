import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import type { HookCommand, HooksConfig } from '@/core/hooks/types';

describe('HookRegistry', () => {
  let registry: HookRegistry;

  const command: HookCommand = { type: 'command', command: 'echo hello' };
  const httpHook: HookCommand = { type: 'http', url: 'https://example.com/hook' };

  beforeEach(() => {
    registry = new HookRegistry();
  });

  describe('register / getMatchingHooks', () => {
    it('registers a hook and retrieves it', () => {
      registry.register('PreToolUse', command, 'config', 'browser_dom');
      const hooks = registry.getMatchingHooks('PreToolUse', 'browser_dom');
      expect(hooks).toHaveLength(1);
      expect(hooks[0].command).toBe(command);
      expect(hooks[0].source).toBe('config');
    });

    it('returns empty array for unmatched event', () => {
      registry.register('PreToolUse', command, 'config');
      expect(registry.getMatchingHooks('PostToolUse')).toHaveLength(0);
    });

    it('filters by tool name matcher', () => {
      registry.register('PreToolUse', command, 'config', 'browser_dom');
      expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);
      expect(registry.getMatchingHooks('PreToolUse', 'web_search')).toHaveLength(0);
    });

    it('matches all tools when matcher is omitted', () => {
      registry.register('PreToolUse', command, 'config');
      expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);
      expect(registry.getMatchingHooks('PreToolUse', 'anything')).toHaveLength(1);
    });

    it('filters by if condition on the command', () => {
      const conditioned: HookCommand = {
        type: 'command',
        command: 'echo',
        if: 'browser_dom(click)',
      };
      registry.register('PreToolUse', conditioned, 'config');
      expect(
        registry.getMatchingHooks('PreToolUse', 'browser_dom', { action: 'click' }),
      ).toHaveLength(1);
      expect(
        registry.getMatchingHooks('PreToolUse', 'browser_dom', { action: 'type' }),
      ).toHaveLength(0);
    });

    it('supports multiple hooks per event', () => {
      registry.register('PreToolUse', command, 'config');
      registry.register('PreToolUse', httpHook, 'session');
      expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(2);
    });
  });

  describe('unregister', () => {
    it('removes a hook by ID', () => {
      const id = registry.register('PreToolUse', command, 'config');
      expect(registry.unregister(id)).toBe(true);
      expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(0);
    });

    it('returns false for unknown ID', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('unregisterBySource', () => {
    it('removes all hooks from a given source', () => {
      registry.register('PreToolUse', command, 'config');
      registry.register('PreToolUse', httpHook, 'config');
      registry.register('PostToolUse', command, 'session');
      expect(registry.unregisterBySource('config')).toBe(2);
      expect(registry.getMatchingHooks('PreToolUse')).toHaveLength(0);
      expect(registry.getMatchingHooks('PostToolUse')).toHaveLength(1);
    });

    it('Track 10: removes only the matching plugin variant by pluginId', () => {
      registry.register('PreToolUse', command, { type: 'plugin', pluginId: 'a' });
      registry.register('PreToolUse', command, { type: 'plugin', pluginId: 'b' });
      registry.register('PreToolUse', command, 'config');
      registry.register('PreToolUse', command, 'session');

      const removed = registry.unregisterBySource({ type: 'plugin', pluginId: 'a' });
      expect(removed).toBe(1);

      const remaining = registry.getMatchingHooks('PreToolUse');
      expect(remaining).toHaveLength(3);
      const sources = remaining.map((h) => h.source);
      expect(sources).toEqual(
        expect.arrayContaining([
          'config',
          'session',
          { type: 'plugin', pluginId: 'b' },
        ]),
      );
    });

    it('Track 10: plugin-source removal does not touch string-source hooks', () => {
      registry.register('PreToolUse', command, 'config');
      registry.register('PreToolUse', command, { type: 'plugin', pluginId: 'a' });

      expect(registry.unregisterBySource({ type: 'plugin', pluginId: 'a' })).toBe(1);
      const remaining = registry.getMatchingHooks('PreToolUse');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].source).toBe('config');
    });
  });

  describe('registerFromConfig', () => {
    it('bulk registers hooks from config', () => {
      const config: HooksConfig = {
        PreToolUse: [
          { matcher: 'browser_dom', hooks: [command] },
          { matcher: 'web_search', hooks: [httpHook] },
        ],
        SessionStart: [
          { hooks: [command] },
        ],
      };
      const ids = registry.registerFromConfig(config, 'config');
      expect(ids).toHaveLength(3);
      expect(registry.getMatchingHooks('PreToolUse', 'browser_dom')).toHaveLength(1);
      expect(registry.getMatchingHooks('PreToolUse', 'web_search')).toHaveLength(1);
      expect(registry.getMatchingHooks('SessionStart')).toHaveLength(1);
    });
  });

  describe('registerFromConfig — event name validation', () => {
    it('skips unknown event names with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        PreTooluse: [{ hooks: [command] }],  // typo: lowercase 'u'
        PreToolUse: [{ hooks: [command] }],  // correct
      };
      const ids = registry.registerFromConfig(config as any, 'config');
      expect(ids).toHaveLength(1); // only the valid one
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown hook event "PreTooluse"'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('hasHooksFor', () => {
    it('returns false when no hooks registered', () => {
      expect(registry.hasHooksFor('PreToolUse')).toBe(false);
    });

    it('returns true when hooks exist for event', () => {
      registry.register('PreToolUse', command, 'config');
      expect(registry.hasHooksFor('PreToolUse')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all hooks', () => {
      registry.register('PreToolUse', command, 'config');
      registry.register('PostToolUse', httpHook, 'session');
      registry.clear();
      expect(registry.hasHooksFor('PreToolUse')).toBe(false);
      expect(registry.hasHooksFor('PostToolUse')).toBe(false);
    });
  });

  describe('getAllHooks', () => {
    it('returns a copy of all hooks', () => {
      registry.register('PreToolUse', command, 'config');
      const all = registry.getAllHooks();
      expect(all.get('PreToolUse')).toHaveLength(1);
      // Verify it is a copy
      all.clear();
      expect(registry.hasHooksFor('PreToolUse')).toBe(true);
    });
  });
});
