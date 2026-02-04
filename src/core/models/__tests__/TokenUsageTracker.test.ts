import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenUsageTracker, createDefaultTokenUsageConfig } from '../TokenUsageTracker.js';
import { createEmptyTokenUsage } from '../types/TokenUsage.js';
import type { TokenUsage } from '../types/TokenUsage.js';

describe('TokenUsageTracker', () => {
  let tokenUsageTracker: TokenUsageTracker;

  beforeEach(() => {
    const config = createDefaultTokenUsageConfig('gpt-4o', {
      maxHistoryAge: 60000, // 1 minute for tests
      maxHistoryEntries: 100,
    });
    tokenUsageTracker = new TokenUsageTracker(config);
  });

  describe('Token Usage Aggregation', () => {
    it('should aggregate token usage correctly across multiple updates', () => {
      const usage1: TokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 180,
      };

      const usage2: TokenUsage = {
        input_tokens: 150,
        cached_input_tokens: 30,
        output_tokens: 75,
        reasoning_output_tokens: 15,
        total_tokens: 270,
      };

      tokenUsageTracker.update(usage1, 'turn-1');
      const info = tokenUsageTracker.update(usage2, 'turn-2');

      expect(info.total_token_usage).toEqual({
        input_tokens: 250,
        cached_input_tokens: 50,
        output_tokens: 125,
        reasoning_output_tokens: 25,
        total_tokens: 450,
      });

      expect(info.last_token_usage).toEqual(usage2);
    });

    it('should track usage over time with filtering', () => {
      const baseTime = Date.now();
      vi.setSystemTime(baseTime);

      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 100 }, 'turn-1');

      vi.setSystemTime(baseTime + 30000); // 30 seconds later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 200 }, 'turn-2');

      vi.setSystemTime(baseTime + 60000); // 1 minute later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 150 }, 'turn-3');

      // Get usage for specific time range
      const recentUsage = tokenUsageTracker.getUsageForRange({
        start: baseTime + 15000,
        end: baseTime + 60000,
      });

      expect(recentUsage.entryCount).toBe(2);
      expect(recentUsage.usage.total_tokens).toBe(350); // 200 + 150
    });

    it('should detect when compaction is needed', () => {
      const config = createDefaultTokenUsageConfig('gpt-4', {
        autoCompactLimit: 1000, // Low limit for testing
      });
      const tracker = new TokenUsageTracker(config);

      // Add usage below limit
      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 500 });
      expect(tracker.shouldCompact()).toBe(false);

      // Add usage that exceeds limit
      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 600 });
      expect(tracker.shouldCompact()).toBe(true);
    });
  });

  describe('Efficiency Metrics', () => {
    it('should calculate efficiency metrics correctly', () => {
      tokenUsageTracker.update({
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 75,
        reasoning_output_tokens: 25,
        total_tokens: 250,
      }, 'turn-1');

      tokenUsageTracker.update({
        input_tokens: 80,
        cached_input_tokens: 20,
        output_tokens: 60,
        reasoning_output_tokens: 15,
        total_tokens: 175,
      }, 'turn-2');

      const metrics = tokenUsageTracker.getEfficiencyMetrics();

      expect(metrics.totalTokens).toBe(425);
      expect(metrics.cacheHitRate).toBeCloseTo(33.33, 1); // (50+20)/(100+50+80+20) * 100
      expect(metrics.inputOutputRatio).toBeCloseTo(1.33, 1); // (100+80)/(75+60)
      expect(metrics.tokensPerTurn).toBeCloseTo(212.5, 1); // 425/2
    });

    it('should handle zero values in efficiency calculations', () => {
      const zeroUsage = createEmptyTokenUsage();
      tokenUsageTracker.update(zeroUsage);

      const metrics = tokenUsageTracker.getEfficiencyMetrics();
      expect(metrics.cacheHitRate).toBe(0);
      expect(metrics.inputOutputRatio).toBe(0);
      expect(metrics.tokensPerTurn).toBe(0);
    });
  });

  describe('Time-based Queries', () => {
    it('should return usage for last N minutes', () => {
      const baseTime = Date.now();
      vi.setSystemTime(baseTime);

      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 100 });

      vi.setSystemTime(baseTime + 30000); // 30 seconds later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 200 });

      vi.setSystemTime(baseTime + 120000); // 2 minutes later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 150 });

      // Get last 1 minute usage (should only include the last entry)
      const lastMinute = tokenUsageTracker.getUsageForLastMinutes(1);
      expect(lastMinute.entryCount).toBe(1);
      expect(lastMinute.usage.total_tokens).toBe(150);
    });

    it('should return usage for last N turns', () => {
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 100 }, 'turn-1');
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 200 }, 'turn-2');
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 150 }, 'turn-3');
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 300 }, 'turn-4');

      const lastTwoTurns = tokenUsageTracker.getUsageForLastTurns(2);
      expect(lastTwoTurns.entryCount).toBe(2);
      expect(lastTwoTurns.usage.total_tokens).toBe(450); // 150 + 300
    });
  });

  describe('Usage Percentage and Compaction', () => {
    it('should calculate usage percentage correctly', () => {
      const config = createDefaultTokenUsageConfig('gpt-4', {
        // gpt-4 has 8192 context window by default
      });
      const tracker = new TokenUsageTracker(config);

      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 4096 });

      const percentage = tracker.getUsagePercentage();
      expect(percentage).toBeCloseTo(50, 1); // 4096/8192 * 100 = 50%
    });

    it('should handle zero context window gracefully', () => {
      const config = createDefaultTokenUsageConfig('unknown-model', {
        contextWindow: 0,
      });
      const tracker = new TokenUsageTracker(config);

      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 1000 });

      const percentage = tracker.getUsagePercentage();
      expect(percentage).toBe(0);
    });
  });

  describe('Configuration Updates', () => {
    it('should update configuration correctly', () => {
      tokenUsageTracker.updateConfig({
        contextWindow: 16384,
        autoCompactLimit: 12000,
      });

      const info = tokenUsageTracker.getSessionInfo();
      expect(info.model_context_window).toBe(16384);
      expect(info.auto_compact_token_limit).toBe(12000);
    });
  });

  describe('Summary Information', () => {
    it('should provide accurate summary', () => {
      tokenUsageTracker.update({
        input_tokens: 100,
        cached_input_tokens: 25,
        output_tokens: 75,
        reasoning_output_tokens: 10,
        total_tokens: 210,
      }, 'turn-1');

      const summary = tokenUsageTracker.getSummary();

      expect(summary.totalTokens).toBe(210);
      expect(summary.lastTurnTokens).toBe(210);
      expect(summary.historyEntries).toBe(1);
      expect(summary.efficiency.cacheHitRate).toBeCloseTo(20, 1); // 25/(100+25) * 100
    });

    it('should handle empty state correctly', () => {
      const summary = tokenUsageTracker.getSummary();

      expect(summary.totalTokens).toBe(0);
      expect(summary.lastTurnTokens).toBe(0);
      expect(summary.usagePercentage).toBe(0);
      expect(summary.shouldCompact).toBe(false);
      expect(summary.historyEntries).toBe(0);
    });
  });

  describe('Rapid Updates', () => {
    it('should maintain consistency during rapid updates', () => {
      // Simulate rapid token usage updates
      for (let i = 0; i < 50; i++) {
        tokenUsageTracker.update({
          ...createEmptyTokenUsage(),
          total_tokens: i * 10,
        }, `rapid-${i}`);
      }

      const sessionInfo = tokenUsageTracker.getSessionInfo();
      expect(sessionInfo.total_token_usage.total_tokens).toBe(12250); // Sum of 0+10+20+...+490

      const history = tokenUsageTracker.getHistory();
      expect(history.length).toBe(50);
    });
  });
});