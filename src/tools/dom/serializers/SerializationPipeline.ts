/**
 * SerializationPipeline: Three-stage orchestrator for DOM compaction
 *
 * Implements deterministic token reduction pipeline with three stages:
 * 1. Signal Filtering: Remove invisible/noise elements
 * 2. Structure Simplification: Collapse wrappers, deduplicate attributes
 * 3. Payload Optimization: Sequential ID remapping, field normalization, compact encoding
 *
 * Core pipeline orchestrator
 */

import { VirtualNode } from '../types';
import { CompactionMetrics } from './CompactionMetrics';
import { IdRemapper } from './optimizers/IdRemapper';
import {
  PipelineConfig,
  SerializationResult,
  DEFAULT_PIPELINE_CONFIG,
  IIdRemapper
} from '../types';

// Import filters
import { VisibilityFilter } from './filters/VisibilityFilter';
import { TextNodeFilter } from './filters/TextNodeFilter';
import { NoiseFilter } from './filters/NoiseFilter';
import { SemanticContainerFilter } from './filters/SemanticContainerFilter';
import { PaintOrderFilter } from './filters/PaintOrderFilter';

// Import simplifiers
import { TextCollapser } from './simplifiers/TextCollapser';
import { LayoutSimplifier } from './simplifiers/LayoutSimplifier';
import { AttributeDeduplicator } from './simplifiers/AttributeDeduplicator';
import { PropagatingBoundsFilter } from './simplifiers/PropagatingBoundsFilter';

// Import optimizers
import { AttributePruner } from './optimizers/AttributePruner';
import { FieldNormalizer } from './optimizers/FieldNormalizer';
import { NumericCompactor } from './optimizers/NumericCompactor';
import { MetadataBucketer } from './optimizers/MetadataBucketer';

export class SerializationPipeline {
  private config: PipelineConfig;
  private metrics: CompactionMetrics;
  private idRemapper: IdRemapper;

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
    this.metrics = new CompactionMetrics();
    this.idRemapper = new IdRemapper();
  }

  /**
   * Execute the three-stage serialization pipeline
   * @param virtualDom - Root VirtualNode tree
   * @returns SerializationResult with optimized tree, metrics, and ID remapper
   */
  execute(virtualDom: VirtualNode): SerializationResult {
    const startTime = Date.now();

    // Collect baseline metrics
    this.collectBaselineMetrics(virtualDom);

    // Make a deep copy to avoid mutating input
    let tree = this.cloneTree(virtualDom);

    // Stage 1: Signal Filtering
    if (this.hasFiltersEnabled()) {
      tree = this.applyFilters(tree);
    }

    // Stage 2: Structure Simplification
    if (this.hasSimplifiersEnabled()) {
      tree = this.applySimplifiers(tree);
    }

    // Stage 3: Payload Optimization
    if (this.hasOptimizersEnabled()) {
      tree = this.applyOptimizers(tree);
    }

    // Collect final metrics
    this.collectFinalMetrics(tree);
    this.metrics.serializationTimeMs = Date.now() - startTime;
    this.metrics.calculateCompactionScore();

    return {
      tree,
      metrics: this.metrics,
      idRemapper: this.idRemapper
    };
  }

  /**
   * Get the ID remapper for action translation
   */
  getIdRemapper(): IIdRemapper {
    return this.idRemapper;
  }

  /**
   * Get current metrics
   */
  getMetrics(): CompactionMetrics {
    return this.metrics;
  }

  /**
   * Stage 1: Apply signal filters to remove invisible/noise elements
   */
  private applyFilters(tree: VirtualNode): VirtualNode {
    const stageStart = Date.now();
    let filtered = tree;

    // F1: VisibilityFilter - Remove hidden elements
    if (this.config.enableVisibilityFilter) {
      filtered = this.applyVisibilityFilter(filtered);
    }

    // F2: TextNodeFilter - Remove tiny text nodes
    if (this.config.enableTextNodeFilter) {
      filtered = this.applyTextNodeFilter(filtered);
    }

    // F3: NoiseFilter - Remove script/style/meta
    if (this.config.enableNoiseFilter) {
      filtered = this.applyNoiseFilter(filtered);
    }

    // F4: SemanticContainerFilter - Require interactive descendants
    if (this.config.enableSemanticContainerFilter) {
      filtered = this.applySemanticContainerFilter(filtered);
    }

    // F5: PaintOrderFilter - Remove obscured elements
    if (this.config.enablePaintOrderFilter) {
      filtered = this.applyPaintOrderFilter(filtered);
    }

    this.metrics.stage1TimeMs = Date.now() - stageStart;
    return filtered;
  }

  /**
   * Stage 2: Apply structure simplifiers to collapse wrappers and deduplicate
   */
  private applySimplifiers(tree: VirtualNode): VirtualNode {
    const stageStart = Date.now();
    let simplified = tree;

    // S2.1: TextCollapser - Merge consecutive text
    if (this.config.enableTextCollapsing) {
      simplified = this.applyTextCollapser(simplified);
    }

    // S2.2: LayoutSimplifier - Collapse single-child wrappers
    if (this.config.enableLayoutSimplification) {
      simplified = this.applyLayoutSimplifier(simplified);
    }

    // S2.3: AttributeDeduplicator - Remove redundant attributes
    if (this.config.enableAttributeDeduplication) {
      simplified = this.applyAttributeDeduplicator(simplified);
    }

    // S2.4: PropagatingBoundsFilter - Remove nested clickables
    if (this.config.enablePropagatingBounds) {
      simplified = this.applyPropagatingBoundsFilter(simplified);
    }

    this.metrics.stage2TimeMs = Date.now() - stageStart;
    return simplified;
  }

  /**
   * Stage 3: Apply payload optimizers for compact encoding
   */
  private applyOptimizers(tree: VirtualNode): VirtualNode {
    const stageStart = Date.now();
    let optimized = tree;

    // P3.1: IdRemapper - Sequential ID assignment
    if (this.config.enableIdRemapping) {
      optimized = this.applyIdRemapping(optimized);
    }

    // P3.2: AttributePruner - Keep semantic attributes only
    if (this.config.enableAttributePruning) {
      optimized = this.applyAttributePruner(optimized);
    }

    // P3.3: FieldNormalizer - Snake_case field names
    if (this.config.enableFieldNormalization) {
      optimized = this.applyFieldNormalizer(optimized);
    }

    // P3.4: NumericCompactor - Compact bounding boxes
    if (this.config.enableNumericCompaction) {
      optimized = this.applyNumericCompactor(optimized);
    }

    // P3.5: MetadataBucketer - Collection-level states
    if (this.config.enableMetadataBucketing) {
      optimized = this.applyMetadataBucketer(optimized);
    }

    this.metrics.stage3TimeMs = Date.now() - stageStart;
    return optimized;
  }

  // ========== Filter Implementations ==========

  private applyVisibilityFilter(tree: VirtualNode): VirtualNode {
    const filter = new VisibilityFilter();
    const filtered = filter.filter(tree);
    return filtered || tree; // Return original if filter returns null
  }

  private applyTextNodeFilter(tree: VirtualNode): VirtualNode {
    const filter = new TextNodeFilter(this.config.minTextLength);
    const filtered = filter.filter(tree);
    return filtered || tree;
  }

  private applyNoiseFilter(tree: VirtualNode): VirtualNode {
    const filter = new NoiseFilter();
    const filtered = filter.filter(tree);
    return filtered || tree;
  }

  private applySemanticContainerFilter(tree: VirtualNode): VirtualNode {
    const filter = new SemanticContainerFilter();
    const filtered = filter.filter(tree);
    return filtered || tree;
  }

  private applyPaintOrderFilter(tree: VirtualNode): VirtualNode {
    const filter = new PaintOrderFilter();
    const filtered = filter.filter(tree);
    return filtered || tree;
  }

  // ========== Simplifier Implementations ==========

  private applyTextCollapser(tree: VirtualNode): VirtualNode {
    const collapser = new TextCollapser();
    return collapser.collapse(tree);
  }

  private applyLayoutSimplifier(tree: VirtualNode): VirtualNode {
    const simplifier = new LayoutSimplifier();
    return simplifier.simplify(tree);
  }

  private applyAttributeDeduplicator(tree: VirtualNode): VirtualNode {
    const deduplicator = new AttributeDeduplicator();
    return deduplicator.deduplicate(tree);
  }

  private applyPropagatingBoundsFilter(tree: VirtualNode): VirtualNode {
    const filter = new PropagatingBoundsFilter(this.config.propagatingContainmentThreshold);
    return filter.filter(tree);
  }

  // ========== Optimizer Implementations ==========

  private applyIdRemapping(tree: VirtualNode): VirtualNode {
    // Register nodes with IdRemapper during traversal
    this.traverseAndRegisterIds(tree);
    return tree;
  }

  private traverseAndRegisterIds(node: VirtualNode): void {
    // Register this node's backendNodeId
    this.idRemapper.registerNode(node.backendNodeId);

    // Recurse to children
    if (node.children) {
      for (const child of node.children) {
        this.traverseAndRegisterIds(child);
      }
    }
  }

  private applyAttributePruner(tree: VirtualNode): VirtualNode {
    const pruner = new AttributePruner();
    return pruner.prune(tree);
  }

  private applyFieldNormalizer(tree: VirtualNode): VirtualNode {
    // Note: Field normalization happens during serialization,
    // not tree transformation. Return tree as-is.
    return tree;
  }

  private applyNumericCompactor(tree: VirtualNode): VirtualNode {
    const compactor = new NumericCompactor();
    return compactor.compact(tree);
  }

  private applyMetadataBucketer(tree: VirtualNode): VirtualNode {
    // Note: Metadata bucketing happens during serialization,
    // not tree transformation. Return tree as-is.
    return tree;
  }

  // ========== Metrics Collection ==========

  private collectBaselineMetrics(tree: VirtualNode): void {
    let totalNodes = 0;
    let totalChars = 0;
    let interactiveNodes = 0;

    const traverse = (node: VirtualNode) => {
      totalNodes++;

      // Count characters in node
      if (node.nodeValue) totalChars += node.nodeValue.length;
      if (node.attributes) totalChars += node.attributes.join('').length;

      // Count interactive nodes
      if (node.tier === 'semantic' || node.tier === 'non-semantic') {
        interactiveNodes++;
      }

      // Recurse
      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(tree);

    this.metrics.totalNodes = totalNodes;
    this.metrics.interactiveNodes = interactiveNodes;
    this.metrics.structuralNodes = totalNodes - interactiveNodes;
    this.metrics.totalCharsBefore = totalChars;
    this.metrics.estimatedTokensBefore = CompactionMetrics.estimateTokens(totalChars);
  }

  private collectFinalMetrics(tree: VirtualNode): void {
    let serializedNodes = 0;
    let totalChars = 0;
    let filteredNodes = 0;

    const traverse = (node: VirtualNode) => {
      serializedNodes++;

      // Count characters in node
      if (node.nodeValue) totalChars += node.nodeValue.length;
      if (node.attributes) totalChars += node.attributes.join('').length;

      // Recurse
      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(tree);

    this.metrics.serializedNodes = serializedNodes;
    this.metrics.filteredNodes = this.metrics.totalNodes - serializedNodes;
    this.metrics.totalCharsAfter = totalChars;
    this.metrics.averageCharsPerNode = totalChars / serializedNodes;
    this.metrics.estimatedTokensAfter = CompactionMetrics.estimateTokens(totalChars);
    this.metrics.calculateTokenReduction();
  }

  // ========== Utility Methods ==========

  private cloneTree(node: VirtualNode): VirtualNode {
    const clone: VirtualNode = {
      nodeId: node.nodeId,
      backendNodeId: node.backendNodeId,
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node.localName,
      nodeValue: node.nodeValue,
      attributes: node.attributes ? [...node.attributes] : undefined,
      frameId: node.frameId,
      shadowRootType: node.shadowRootType,
      tier: node.tier,
      interactionType: node.interactionType,
      accessibility: node.accessibility ? { ...node.accessibility } : undefined,
      heuristics: node.heuristics ? { ...node.heuristics } : undefined,
      boundingBox: node.boundingBox ? { ...node.boundingBox } : undefined,
      paintOrder: node.paintOrder,
      computedStyle: node.computedStyle ? { ...node.computedStyle } : undefined,
      scrollRects: node.scrollRects ? { ...node.scrollRects } : undefined,
      clientRects: node.clientRects ? { ...node.clientRects } : undefined,
      ignoredByPaintOrder: node.ignoredByPaintOrder,
      excludedByParent: node.excludedByParent
    };

    if (node.children) {
      clone.children = node.children.map(child => this.cloneTree(child));
    }

    return clone;
  }

  private hasFiltersEnabled(): boolean {
    return (
      this.config.enableVisibilityFilter ||
      this.config.enableTextNodeFilter ||
      this.config.enableNoiseFilter ||
      this.config.enableSemanticContainerFilter ||
      this.config.enablePaintOrderFilter
    );
  }

  private hasSimplifiersEnabled(): boolean {
    return (
      this.config.enableTextCollapsing ||
      this.config.enableLayoutSimplification ||
      this.config.enableAttributeDeduplication ||
      this.config.enablePropagatingBounds
    );
  }

  private hasOptimizersEnabled(): boolean {
    return (
      this.config.enableIdRemapping ||
      this.config.enableAttributePruning ||
      this.config.enableFieldNormalization ||
      this.config.enableNumericCompaction ||
      this.config.enableMetadataBucketing
    );
  }
}
