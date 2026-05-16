/**
 * SessionState unit tests
 * Tests must fail until SessionState is implemented (TDD)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from '../SessionState';
import type { TokenUsageInfo, RateLimitSnapshot } from '../types';

describe('SessionState', () => {
  let state: SessionState;

  beforeEach(() => {
    state = new SessionState();
  });

  describe('History Management', () => {
    it('should start with empty history', () => {
      const snapshot = state.historySnapshot();
      expect(snapshot).toEqual([]);
    });

    it('should record items to history', () => {
      const items = [
        { role: 'user' as const, content: 'Hello', timestamp: Date.now() },
        { role: 'assistant' as const, content: 'Hi there!', timestamp: Date.now() },
      ];

      state.recordItems(items as any);

      const snapshot = state.historySnapshot();
      expect(snapshot).toHaveLength(2);
      expect((snapshot[0] as any).content).toBe('Hello');
      expect((snapshot[1] as any).content).toBe('Hi there!');
    });

    it('should append items to existing history', () => {
      const items1 = [
        { role: 'user' as const, content: 'First', timestamp: Date.now() },
      ];
      const items2 = [
        { role: 'assistant' as const, content: 'Second', timestamp: Date.now() },
      ];

      state.recordItems(items1 as any);
      state.recordItems(items2 as any);

      const snapshot = state.historySnapshot();
      expect(snapshot).toHaveLength(2);
    });

    it('should return deep copy of history (immutability)', () => {
      const items = [
        { role: 'user' as const, content: 'Original', timestamp: Date.now() },
      ];

      state.recordItems(items as any);

      const snapshot1 = state.historySnapshot();
      (snapshot1[0] as any).content = 'Modified';

      const snapshot2 = state.historySnapshot();
      expect((snapshot2[0] as any).content).toBe('Original');
    });

    it('should return full conversation history object', () => {
      const items = [
        { role: 'user' as const, content: 'Test', timestamp: Date.now() },
      ];

      state.recordItems(items as any);

      const history = state.getConversationHistory();
      expect(history).toHaveProperty('items');
      expect(history.items).toHaveLength(1);
    });
  });

  describe('Token Tracking', () => {
    it('should start with undefined token info', () => {
      const exported = state.export();
      expect(exported.tokenInfo).toBeUndefined();
    });

    it('should add token usage', () => {
      state.addTokenUsage(100);

      const exported = state.export();
      expect(exported.tokenInfo?.total_tokens).toBe(100);
    });

    it('should accumulate token usage', () => {
      state.addTokenUsage(100);
      state.addTokenUsage(50);
      state.addTokenUsage(25);

      const exported = state.export();
      expect(exported.tokenInfo?.total_tokens).toBe(175);
    });

    it('should track detailed token info', () => {
      const tokenInfo: TokenUsageInfo = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 10,
      };

      state.updateTokenInfo(tokenInfo);

      const exported = state.export();
      expect(exported.tokenInfo).toEqual(tokenInfo);
    });

    it('should merge token info on update', () => {
      state.updateTokenInfo({ input_tokens: 100, total_tokens: 100 });
      state.updateTokenInfo({ output_tokens: 50, total_tokens: 150 });

      const exported = state.export();
      expect(exported.tokenInfo?.input_tokens).toBe(100);
      expect(exported.tokenInfo?.output_tokens).toBe(50);
      expect(exported.tokenInfo?.total_tokens).toBe(150);
    });
  });

  describe('Rate Limit Tracking', () => {
    it('should start with undefined rate limits', () => {
      const exported = state.export();
      expect(exported.latestRateLimits).toBeUndefined();
    });

    it('should update rate limits', () => {
      const rateLimits: RateLimitSnapshot = {
        primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 1200 },
        secondary: { used_percent: 10, window_minutes: 10080 },
      };

      state.updateRateLimits(rateLimits);

      const exported = state.export();
      expect(exported.latestRateLimits).toEqual(rateLimits);
    });

    it('should expose the latest snapshot via getRateLimits()', () => {
      expect(state.getRateLimits()).toBeUndefined();
      const snapshot: RateLimitSnapshot = {
        primary: { used_percent: 55 },
      };
      state.updateRateLimits(snapshot);
      expect(state.getRateLimits()).toEqual(snapshot);
    });

    it('should replace previous rate limits on update', () => {
      const rateLimits1: RateLimitSnapshot = {
        primary: { used_percent: 50 },
      };

      const rateLimits2: RateLimitSnapshot = {
        primary: { used_percent: 80 },
      };

      state.updateRateLimits(rateLimits1);
      state.updateRateLimits(rateLimits2);

      const exported = state.export();
      expect(exported.latestRateLimits?.primary?.used_percent).toBe(80);
    });
  });

  describe('Approved Commands', () => {
    it('should start with no approved commands', () => {
      const exported = state.export();
      expect(exported.approvedCommands).toEqual([]);
    });

    it('should add approved command', () => {
      state.addApprovedCommand('npm install');

      const exported = state.export();
      expect(exported.approvedCommands).toContain('npm install');
    });

    it('should add multiple approved commands', () => {
      state.addApprovedCommand('npm install');
      state.addApprovedCommand('git status');
      state.addApprovedCommand('ls -la');

      const exported = state.export();
      expect(exported.approvedCommands).toHaveLength(3);
      expect(exported.approvedCommands).toContain('npm install');
      expect(exported.approvedCommands).toContain('git status');
      expect(exported.approvedCommands).toContain('ls -la');
    });

    it('should not duplicate approved commands', () => {
      state.addApprovedCommand('npm install');
      state.addApprovedCommand('npm install');
      state.addApprovedCommand('npm install');

      const exported = state.export();
      expect(exported.approvedCommands).toHaveLength(1);
    });

    it('should check if command is approved', () => {
      state.addApprovedCommand('npm install');

      expect(state.isCommandApproved('npm install')).toBe(true);
      expect(state.isCommandApproved('rm -rf /')).toBe(false);
    });
  });

  describe('Export/Import', () => {
    it('should export complete state', () => {
      const items = [
        { role: 'user' as const, content: 'Test', timestamp: Date.now() },
      ];

      state.recordItems(items as any);
      state.addTokenUsage(100);
      state.addApprovedCommand('npm test');

      const exported = state.export();

      expect(exported.history).toBeDefined();
      expect(exported.history.items).toHaveLength(1);
      expect(exported.tokenInfo?.total_tokens).toBe(100);
      expect(exported.approvedCommands).toContain('npm test');
    });

    it('should import from exported state', () => {
      const items = [
        { role: 'user' as const, content: 'Original', timestamp: Date.now() },
      ];

      state.recordItems(items as any);
      state.addTokenUsage(200);
      state.addApprovedCommand('git commit');

      const exported = state.export();

      const imported = SessionState.import(exported);
      const reimported = imported.export();

      expect(reimported.history.items).toHaveLength(1);
      expect((reimported.history.items[0] as any).content).toBe('Original');
      expect(reimported.tokenInfo?.total_tokens).toBe(200);
      expect(reimported.approvedCommands).toContain('git commit');
    });

    it('should handle import of empty state', () => {
      const emptyExport = state.export();
      const imported = SessionState.import(emptyExport);
      const snapshot = imported.historySnapshot();

      expect(snapshot).toEqual([]);
    });

    it('should preserve all data through round-trip', () => {
      state.recordItems([
        { role: 'user' as const, content: 'User msg', timestamp: Date.now() },
        { role: 'assistant' as const, content: 'AI msg', timestamp: Date.now() },
      ] as any);
      state.addTokenUsage(150);
      state.updateRateLimits({
        primary: { used_percent: 70, window_minutes: 300 },
      });
      state.addApprovedCommand('cmd1');
      state.addApprovedCommand('cmd2');

      const exported = state.export();
      const imported = SessionState.import(exported);
      const reimported = imported.export();

      expect(reimported.history.items).toHaveLength(2);
      expect(reimported.tokenInfo?.total_tokens).toBe(150);
      expect(reimported.latestRateLimits?.primary?.used_percent).toBe(70);
      expect(reimported.approvedCommands).toHaveLength(2);
    });
  });

  describe('Deep Copy', () => {
    it('should create independent copy', () => {
      const items = [
        { role: 'user' as const, content: 'Original', timestamp: Date.now() },
      ];

      state.recordItems(items as any);
      state.addTokenUsage(100);

      const copy = state.deepCopy();

      // Modify original
      state.recordItems([
        { role: 'assistant' as const, content: 'More', timestamp: Date.now() },
      ] as any);
      state.addTokenUsage(50);

      // Verify copy unchanged
      const copySnapshot = copy.historySnapshot();
      const copyExport = copy.export();

      expect(copySnapshot).toHaveLength(1);
      expect(copyExport.tokenInfo?.total_tokens).toBe(100);

      // Verify original changed
      const originalSnapshot = state.historySnapshot();
      const originalExport = state.export();

      expect(originalSnapshot).toHaveLength(2);
      expect(originalExport.tokenInfo?.total_tokens).toBe(150);
    });

    it('should deep copy approved commands', () => {
      state.addApprovedCommand('cmd1');

      const copy = state.deepCopy();

      state.addApprovedCommand('cmd2');

      const copyExport = copy.export();
      const originalExport = state.export();

      expect(copyExport.approvedCommands).toHaveLength(1);
      expect(originalExport.approvedCommands).toHaveLength(2);
    });
  });
});
