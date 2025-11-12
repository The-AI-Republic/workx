/**
 * CompactionMetrics: Track and report serialization pipeline metrics
 *
 * This class provides instrumentation for the DOM serialization pipeline,
 * tracking token reduction, node counts, performance timing, and compaction scores.
 */

import { CompactionMetrics as ICompactionMetrics } from '../types';

export class CompactionMetrics implements ICompactionMetrics {
  // Node counts
  totalNodes: number = 0;
  interactiveNodes: number = 0;
  structuralNodes: number = 0;
  filteredNodes: number = 0;
  serializedNodes: number = 0;

  // Token metrics
  estimatedTokensBefore: number = 0;
  estimatedTokensAfter: number = 0;
  tokenReductionRate: number = 0;

  // Character counts
  totalCharsBefore: number = 0;
  totalCharsAfter: number = 0;
  averageCharsPerNode: number = 0;

  // Performance
  serializationTimeMs: number = 0;
  stage1TimeMs: number = 0;
  stage2TimeMs: number = 0;
  stage3TimeMs: number = 0;

  // Stage-specific metrics
  visibilityFiltered: number = 0;
  textNodesFiltered: number = 0;
  noiseFiltered: number = 0;
  containersFiltered: number = 0;
  paintOrderFiltered: number = 0;
  propagatingBoundsFiltered: number = 0;

  // Compaction score
  compactionScore: number = 0;

  /**
   * Calculate compaction score based on reduction rates
   * Formula: 0.4 × textReduction + 0.4 × nodeReduction + 0.2 × metadataReduction
   */
  calculateCompactionScore(): number {
    // Text reduction rate
    const textReduction = this.totalCharsBefore > 0
      ? (this.totalCharsBefore - this.totalCharsAfter) / this.totalCharsBefore
      : 0;

    // Node reduction rate
    const nodeReduction = this.totalNodes > 0
      ? (this.totalNodes - this.serializedNodes) / this.totalNodes
      : 0;

    // Metadata reduction (use token reduction as proxy)
    const metadataReduction = this.tokenReductionRate;

    // Weighted score
    this.compactionScore = (
      0.4 * textReduction +
      0.4 * nodeReduction +
      0.2 * metadataReduction
    );

    return this.compactionScore;
  }

  /**
   * Calculate token reduction rate
   */
  calculateTokenReduction(): void {
    if (this.estimatedTokensBefore > 0) {
      this.tokenReductionRate =
        (this.estimatedTokensBefore - this.estimatedTokensAfter) / this.estimatedTokensBefore;
    } else {
      this.tokenReductionRate = 0;
    }
  }

  /**
   * Estimate token count from character count
   * Uses approximate rate: 1 token ≈ 3.8 characters (typical for English text)
   */
  static estimateTokens(charCount: number): number {
    return Math.ceil(charCount / 3.8);
  }

  /**
   * Export metrics as JSON
   */
  toJSON(): Record<string, number> {
    return {
      totalNodes: this.totalNodes,
      interactiveNodes: this.interactiveNodes,
      structuralNodes: this.structuralNodes,
      filteredNodes: this.filteredNodes,
      serializedNodes: this.serializedNodes,
      estimatedTokensBefore: this.estimatedTokensBefore,
      estimatedTokensAfter: this.estimatedTokensAfter,
      tokenReductionRate: this.tokenReductionRate,
      totalCharsBefore: this.totalCharsBefore,
      totalCharsAfter: this.totalCharsAfter,
      averageCharsPerNode: this.averageCharsPerNode,
      serializationTimeMs: this.serializationTimeMs,
      stage1TimeMs: this.stage1TimeMs,
      stage2TimeMs: this.stage2TimeMs,
      stage3TimeMs: this.stage3TimeMs,
      visibilityFiltered: this.visibilityFiltered,
      textNodesFiltered: this.textNodesFiltered,
      noiseFiltered: this.noiseFiltered,
      containersFiltered: this.containersFiltered,
      paintOrderFiltered: this.paintOrderFiltered,
      propagatingBoundsFiltered: this.propagatingBoundsFiltered,
      compactionScore: this.compactionScore,
    };
  }

  /**
   * Create a summary string for logging
   */
  toString(): string {
    return [
      `Token Reduction: ${(this.tokenReductionRate * 100).toFixed(1)}%`,
      `(${this.estimatedTokensBefore} → ${this.estimatedTokensAfter} tokens)`,
      `Nodes: ${this.totalNodes} → ${this.serializedNodes}`,
      `(${this.filteredNodes} filtered)`,
      `Time: ${this.serializationTimeMs.toFixed(1)}ms`,
      `Score: ${this.compactionScore.toFixed(2)}`,
    ].join(' | ');
  }
}
