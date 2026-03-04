/**
 * Unit tests for PolicyRulesEngine
 */

import { describe, it, expect } from 'vitest';
import { PolicyRulesEngine } from '../PolicyRulesEngine';
import type { PolicyRule } from '../types';

describe('PolicyRulesEngine', () => {
  describe('rule evaluation ordering', () => {
    it('should evaluate deny rules before ask and allow', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'terminal' }, description: 'Allow terminal' },
        { type: 'deny', match: { tool: 'terminal' }, description: 'Deny terminal' },
        { type: 'ask', match: { tool: 'terminal' }, description: 'Ask terminal' },
      ];

      const engine = new PolicyRulesEngine(rules);
      const decision = engine.evaluate('terminal', {}, 50);

      expect(decision).toBe('deny');
    });

    it('should evaluate ask rules before allow', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'terminal' }, description: 'Allow terminal' },
        { type: 'ask', match: { tool: 'terminal' }, description: 'Ask terminal' },
      ];

      const engine = new PolicyRulesEngine(rules);
      const decision = engine.evaluate('terminal', {}, 50);

      expect(decision).toBe('ask_user');
    });

    it('should return allow when only allow rules match', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'planning_tool' }, description: 'Allow planning' },
      ];

      const engine = new PolicyRulesEngine(rules);
      const decision = engine.evaluate('planning_tool', {}, 0);

      expect(decision).toBe('auto_approve');
    });

    it('should return undefined when no rules match', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'planning_tool' }, description: 'Allow planning' },
      ];

      const engine = new PolicyRulesEngine(rules);
      const decision = engine.evaluate('unknown_tool', {}, 50);

      expect(decision).toBeUndefined();
    });
  });

  describe('tool name matching', () => {
    it('should match exact tool names', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'planning_tool' }, description: 'Allow planning' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('planning_tool', {}, 0)).toBe('auto_approve');
      expect(engine.evaluate('dom_tool', {}, 0)).toBeUndefined();
    });

    it('should match wildcard patterns', () => {
      const rules: PolicyRule[] = [
        { type: 'ask', match: { tool: 'browser__*' }, description: 'Ask for browser tools' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('browser__click', {}, 0)).toBe('ask_user');
      expect(engine.evaluate('browser__type', {}, 0)).toBe('ask_user');
      expect(engine.evaluate('terminal', {}, 0)).toBeUndefined();
    });

    it('should match * to any tool', () => {
      const rules: PolicyRule[] = [
        { type: 'ask', match: { tool: '*', riskAbove: 30 }, description: 'Ask for risky tools' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('any_tool', {}, 50)).toBe('ask_user');
      expect(engine.evaluate('any_tool', {}, 10)).toBeUndefined(); // below threshold
    });
  });

  describe('risk threshold matching', () => {
    it('should match when risk score exceeds threshold', () => {
      const rules: PolicyRule[] = [
        { type: 'deny', match: { riskAbove: 85 }, description: 'Deny critical' },
        { type: 'ask', match: { riskAbove: 30 }, description: 'Ask medium+' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('tool', {}, 90)).toBe('deny');
      expect(engine.evaluate('tool', {}, 50)).toBe('ask_user');
      expect(engine.evaluate('tool', {}, 10)).toBeUndefined();
    });

    it('should not match when risk score equals threshold (not above)', () => {
      const rules: PolicyRule[] = [
        { type: 'ask', match: { riskAbove: 30 }, description: 'Ask when above 30' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('tool', {}, 30)).toBeUndefined();
      expect(engine.evaluate('tool', {}, 31)).toBe('ask_user');
    });
  });

  describe('parameter pattern matching', () => {
    it('should match parameter values (not keys) as regex', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'browser_dom', pattern: '^snapshot$' }, description: 'Allow snapshot' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('browser_dom', { action: 'snapshot' }, 0)).toBe('auto_approve');
      expect(engine.evaluate('browser_dom', { action: 'click' }, 0)).toBeUndefined();
    });

    it('should not match parameter keys, only values', () => {
      const rules: PolicyRule[] = [
        { type: 'deny', match: { tool: 'browser_dom', pattern: '^action$' }, description: 'Pattern matches key name' },
      ];

      const engine = new PolicyRulesEngine(rules);

      // "action" is a parameter key, not a value — should not match
      expect(engine.evaluate('browser_dom', { action: 'snapshot' }, 0)).toBeUndefined();
      // But if "action" appears as a parameter value, it should match
      expect(engine.evaluate('browser_dom', { type: 'action' }, 0)).toBe('deny');
    });

    it('should match across multiple parameter values', () => {
      const rules: PolicyRule[] = [
        { type: 'ask', match: { tool: 'browser_dom', pattern: '^click$' }, description: 'Ask for click' },
      ];

      const engine = new PolicyRulesEngine(rules);

      // "click" appears as the action value
      expect(engine.evaluate('browser_dom', { action: 'click', node_id: '1:42' }, 0)).toBe('ask_user');
      // "click" does not appear in any value
      expect(engine.evaluate('browser_dom', { action: 'scroll', node_id: '1:42' }, 0)).toBeUndefined();
    });

    it('should extract terminal commands for pattern matching', () => {
      const rules: PolicyRule[] = [
        { type: 'allow', match: { tool: 'terminal', pattern: '^(ls|cat|grep)\\b' }, description: 'Allow read commands' },
      ];

      const engine = new PolicyRulesEngine(rules);

      expect(engine.evaluate('terminal', { command: 'ls -la' }, 0)).toBe('auto_approve');
      expect(engine.evaluate('terminal', { command: 'cat file.txt' }, 0)).toBe('auto_approve');
      expect(engine.evaluate('terminal', { command: 'rm file.txt' }, 0)).toBeUndefined();
    });

    it('should throw on invalid regex patterns at construction time', () => {
      const rules: PolicyRule[] = [
        { type: 'deny', match: { pattern: '[invalid' }, description: 'Invalid regex' },
      ];

      expect(() => new PolicyRulesEngine(rules)).toThrow('Invalid regex pattern');
    });
  });

  describe('combined match criteria (AND logic)', () => {
    it('should require all conditions to match', () => {
      const rules: PolicyRule[] = [
        {
          type: 'deny',
          match: { tool: 'terminal', pattern: 'rm\\s+(?=(-[rf]+\\s+)*-[rf]*r)(-[rf]+\\s+)+/', riskAbove: 80 },
          description: 'Deny destructive rm on root',
        },
      ];

      const engine = new PolicyRulesEngine(rules);

      // All conditions match
      expect(engine.evaluate('terminal', { command: 'rm -rf /' }, 90)).toBe('deny');

      // Tool matches, pattern matches, but risk below threshold
      expect(engine.evaluate('terminal', { command: 'rm -rf /' }, 50)).toBeUndefined();

      // Tool matches, risk matches, but pattern doesn't
      expect(engine.evaluate('terminal', { command: 'ls' }, 90)).toBeUndefined();

      // Risk and pattern match, but wrong tool
      expect(engine.evaluate('dom_tool', { command: 'rm -rf /' }, 90)).toBeUndefined();
    });

    it('should not deny rm -f on a specific file path', () => {
      const rules: PolicyRule[] = [
        {
          type: 'deny',
          match: { tool: 'terminal', pattern: 'rm\\s+(?=(-[rf]+\\s+)*-[rf]*r)(-[rf]+\\s+)+/', riskAbove: 80 },
          description: 'Deny destructive rm on root',
        },
      ];

      const engine = new PolicyRulesEngine(rules);

      // rm -f without -r should not match the deny pattern
      expect(engine.evaluate('terminal', { command: 'rm -f /home/user/file.txt' }, 90)).toBeUndefined();

      // rm -rf should still match
      expect(engine.evaluate('terminal', { command: 'rm -rf /' }, 90)).toBe('deny');
    });
  });

  describe('empty rules', () => {
    it('should return undefined for empty rule set', () => {
      const engine = new PolicyRulesEngine([]);

      expect(engine.evaluate('any_tool', {}, 50)).toBeUndefined();
    });
  });
});
