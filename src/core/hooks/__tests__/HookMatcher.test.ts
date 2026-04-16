import { describe, it, expect } from 'vitest';
import { HookMatcher } from '@/core/hooks/HookMatcher';

describe('HookMatcher', () => {
  describe('matches', () => {
    it('matches everything when pattern is undefined', () => {
      expect(HookMatcher.matches(undefined, 'browser_dom')).toBe(true);
      expect(HookMatcher.matches(undefined, 'web_search')).toBe(true);
    });

    it('matches everything when pattern is empty string', () => {
      expect(HookMatcher.matches('', 'browser_dom')).toBe(true);
    });

    it('matches everything when pattern is wildcard', () => {
      expect(HookMatcher.matches('*', 'browser_dom')).toBe(true);
      expect(HookMatcher.matches('*', 'anything')).toBe(true);
    });

    it('matches exact tool name', () => {
      expect(HookMatcher.matches('browser_dom', 'browser_dom')).toBe(true);
      expect(HookMatcher.matches('browser_dom', 'web_search')).toBe(false);
    });

    it('matches pipe-separated alternatives', () => {
      expect(HookMatcher.matches('browser_dom|web_search', 'browser_dom')).toBe(true);
      expect(HookMatcher.matches('browser_dom|web_search', 'web_search')).toBe(true);
      expect(HookMatcher.matches('browser_dom|web_search', 'terminal')).toBe(false);
    });

    it('matches tool name with action filter', () => {
      expect(
        HookMatcher.matches('browser_dom(click)', 'browser_dom', { action: 'click' }),
      ).toBe(true);
      expect(
        HookMatcher.matches('browser_dom(click)', 'browser_dom', { action: 'type' }),
      ).toBe(false);
      expect(
        HookMatcher.matches('browser_dom(click)', 'browser_dom', {}),
      ).toBe(false);
    });

    it('matches multiple action alternatives', () => {
      expect(
        HookMatcher.matches('browser_dom(click|type)', 'browser_dom', { action: 'click' }),
      ).toBe(true);
      expect(
        HookMatcher.matches('browser_dom(click|type)', 'browser_dom', { action: 'type' }),
      ).toBe(true);
      expect(
        HookMatcher.matches('browser_dom(click|type)', 'browser_dom', { action: 'scroll' }),
      ).toBe(false);
    });

    it('fails when tool name does not match even if action matches', () => {
      expect(
        HookMatcher.matches('browser_dom(click)', 'other_tool', { action: 'click' }),
      ).toBe(false);
    });

    it('uses command parameter as fallback action', () => {
      expect(
        HookMatcher.matches('terminal(ls)', 'terminal', { command: 'ls' }),
      ).toBe(true);
    });
  });

  describe('matchesCondition', () => {
    it('returns true when condition is undefined', () => {
      expect(HookMatcher.matchesCondition(undefined, 'browser_dom')).toBe(true);
    });

    it('returns true when condition is empty', () => {
      expect(HookMatcher.matchesCondition('', 'browser_dom')).toBe(true);
    });

    it('evaluates condition using matches logic', () => {
      expect(
        HookMatcher.matchesCondition('browser_dom(click)', 'browser_dom', { action: 'click' }),
      ).toBe(true);
      expect(
        HookMatcher.matchesCondition('browser_dom(click)', 'browser_dom', { action: 'type' }),
      ).toBe(false);
    });
  });

  describe('parse', () => {
    it('parses simple tool name', () => {
      const result = HookMatcher.parse('browser_dom');
      expect(result.toolNames).toEqual(['browser_dom']);
      expect(result.actions).toEqual([]);
    });

    it('parses pipe-separated tool names', () => {
      const result = HookMatcher.parse('browser_dom|web_search');
      expect(result.toolNames).toEqual(['browser_dom', 'web_search']);
      expect(result.actions).toEqual([]);
    });

    it('parses tool name with single action', () => {
      const result = HookMatcher.parse('browser_dom(click)');
      expect(result.toolNames).toEqual(['browser_dom']);
      expect(result.actions).toEqual(['click']);
    });

    it('parses tool name with multiple actions', () => {
      const result = HookMatcher.parse('browser_dom(click|type|scroll)');
      expect(result.toolNames).toEqual(['browser_dom']);
      expect(result.actions).toEqual(['click', 'type', 'scroll']);
    });

    it('handles missing closing paren', () => {
      const result = HookMatcher.parse('browser_dom(click');
      expect(result.toolNames).toEqual(['browser_dom']);
      expect(result.actions).toEqual(['click']);
    });
  });
});
