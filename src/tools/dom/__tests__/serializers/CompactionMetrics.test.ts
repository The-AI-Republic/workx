/**
 * Unit tests for CompactionMetrics
 * Test metric tracking and compaction score calculation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CompactionMetrics } from '../../serializers/CompactionMetrics';

describe('CompactionMetrics', () => {
  let metrics: CompactionMetrics;

  beforeEach(() => {
    metrics = new CompactionMetrics();
  });

  describe('initialization', () => {
    it('should initialize with zero values', () => {
      expect(metrics.totalNodes).toBe(0);
      expect(metrics.interactiveNodes).toBe(0);
      expect(metrics.structuralNodes).toBe(0);
      expect(metrics.filteredNodes).toBe(0);
      expect(metrics.serializedNodes).toBe(0);
      expect(metrics.estimatedTokensBefore).toBe(0);
      expect(metrics.estimatedTokensAfter).toBe(0);
      expect(metrics.tokenReductionRate).toBe(0);
      expect(metrics.totalCharsBefore).toBe(0);
      expect(metrics.totalCharsAfter).toBe(0);
      expect(metrics.compactionScore).toBe(0);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens based on character count', () => {
      const chars = 1000;
      const tokens = metrics.estimateTokens(chars);

      // Assuming ~4 chars per token
      expect(tokens).toBe(Math.ceil(chars / 4));
    });

    it('should handle zero characters', () => {
      const tokens = metrics.estimateTokens(0);
      expect(tokens).toBe(0);
    });

    it('should handle small character counts', () => {
      const tokens = metrics.estimateTokens(5);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('calculateTokenReduction', () => {
    it('should calculate token reduction rate', () => {
      metrics.totalCharsBefore = 10000;
      metrics.totalCharsAfter = 3000;
      metrics.estimatedTokensBefore = metrics.estimateTokens(10000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(3000);

      metrics.calculateTokenReduction();

      // Reduction rate should be (before - after) / before = 0.7 (70%)
      expect(metrics.tokenReductionRate).toBeCloseTo(0.7, 2);
    });

    it('should handle zero before tokens', () => {
      metrics.estimatedTokensBefore = 0;
      metrics.estimatedTokensAfter = 0;

      metrics.calculateTokenReduction();

      expect(metrics.tokenReductionRate).toBe(0);
    });

    it('should handle no reduction case', () => {
      metrics.totalCharsBefore = 1000;
      metrics.totalCharsAfter = 1000;
      metrics.estimatedTokensBefore = metrics.estimateTokens(1000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(1000);

      metrics.calculateTokenReduction();

      expect(metrics.tokenReductionRate).toBe(0);
    });
  });

  describe('calculateCompactionScore', () => {
    it('should calculate compaction score combining text, node, and metadata reduction', () => {
      metrics.totalCharsBefore = 10000;
      metrics.totalCharsAfter = 3000;
      metrics.totalNodes = 1000;
      metrics.serializedNodes = 400;
      metrics.estimatedTokensBefore = metrics.estimateTokens(10000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(3000);
      metrics.calculateTokenReduction();

      const score = metrics.calculateCompactionScore();

      // Score = 0.4 * textReduction + 0.4 * nodeReduction + 0.2 * metadataReduction
      // textReduction = 0.7, nodeReduction = 0.6, metadataReduction = 0.7
      // score = 0.4 * 0.7 + 0.4 * 0.6 + 0.2 * 0.7 = 0.28 + 0.24 + 0.14 = 0.66
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(metrics.compactionScore).toBe(score);
    });

    it('should handle zero values gracefully', () => {
      const score = metrics.calculateCompactionScore();
      expect(score).toBe(0);
    });

    it('should return score between 0 and 1', () => {
      metrics.totalCharsBefore = 1000;
      metrics.totalCharsAfter = 100;
      metrics.totalNodes = 500;
      metrics.serializedNodes = 50;
      metrics.estimatedTokensBefore = metrics.estimateTokens(1000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(100);
      metrics.calculateTokenReduction();

      const score = metrics.calculateCompactionScore();

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('toJSON', () => {
    it('should serialize all metrics to JSON object', () => {
      metrics.totalNodes = 1000;
      metrics.serializedNodes = 400;
      metrics.totalCharsBefore = 10000;
      metrics.totalCharsAfter = 3000;

      const json = metrics.toJSON();

      expect(json).toHaveProperty('totalNodes', 1000);
      expect(json).toHaveProperty('serializedNodes', 400);
      expect(json).toHaveProperty('totalCharsBefore', 10000);
      expect(json).toHaveProperty('totalCharsAfter', 3000);
      expect(json).toHaveProperty('compactionScore');
      expect(json).toHaveProperty('tokenReductionRate');
    });
  });

  describe('toString', () => {
    it('should format metrics as readable string', () => {
      metrics.totalNodes = 1000;
      metrics.serializedNodes = 400;
      metrics.filteredNodes = 600;
      metrics.totalCharsBefore = 10000;
      metrics.totalCharsAfter = 3000;
      metrics.estimatedTokensBefore = metrics.estimateTokens(10000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(3000);
      metrics.calculateTokenReduction();
      metrics.calculateCompactionScore();

      const str = metrics.toString();

      expect(str).toContain('Compaction Metrics');
      expect(str).toContain('1000');
      expect(str).toContain('400');
      expect(str).toContain('600');
    });
  });

  describe('real-world scenario', () => {
    it('should track metrics for typical page compaction', () => {
      // Simulate Gmail inbox page
      metrics.totalNodes = 5000;
      metrics.interactiveNodes = 800;
      metrics.structuralNodes = 4200;
      metrics.filteredNodes = 3500; // 70% filtered out
      metrics.serializedNodes = 1500;

      metrics.totalCharsBefore = 150000;
      metrics.totalCharsAfter = 45000; // 70% reduction

      metrics.estimatedTokensBefore = metrics.estimateTokens(150000);
      metrics.estimatedTokensAfter = metrics.estimateTokens(45000);
      metrics.calculateTokenReduction();

      const score = metrics.calculateCompactionScore();

      // Should achieve good compaction score
      expect(score).toBeGreaterThan(0.5);
      expect(metrics.tokenReductionRate).toBeGreaterThan(0.6);
    });
  });
});
