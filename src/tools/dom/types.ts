// Import types from canonical location for use within this file
import type { SerializedDom, SerializedNode, ActionResult } from '../../types/domTool';

// Re-export types for external consumers
export type { SerializedDom, SerializedNode, ActionResult };

/**
 * Raw serialized DOM structure (before stringification)
 * Internal type used by DomSnapshot.serialize() before transformation
 */
export interface RawSerializedDom {
  page: {
    context: {
      url: string;
      title: string;
      viewport: {
        width: number;
        height: number;
        overflowTop: number;
        overflowBottom: number;
        overflowLeft: number;
        overflowRight: number;
      };
    };
    body: SerializedNode;
    iframes?: Array<{
      url: string;
      title: string;
      body: SerializedNode;
    }>;
    shadowDoms?: Array<{
      hostId: string;
      body: SerializedNode;
    }>;
    metrics?: {
      total_nodes: number;
      serialized_nodes: number;
      token_reduction_rate: number;
      compaction_score: number;
    };
    states?: {
      disabled?: number[];
      checked?: number[];
      required?: number[];
      readonly?: number[];
      expanded?: number[];
      selected?: number[];
    };
  };
}

// Special nodeId constants for non-element targets
/** @deprecated Use the html element's node_id instead for page scroll */
export const NODE_ID_WINDOW = -1;
export const NODE_ID_DOCUMENT = -2;

/**
 * Frame metadata for multi-frame support
 */
export interface FrameMetadata {
  /** Frame ID (0 for main, 1-5 for iframes) */
  frameId: number;
  /** backendNodeId of iframe element (0 for main frame) */
  backendNodeId: number;
  /** Frame viewport dimensions and scroll position */
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  /** Position in parent frame (iframes only) */
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Parsed node ID from frame-scoped format
 */
export interface ParsedNodeId {
  /** Frame ID (0-5) */
  frameId: number;
  /** CDP backend node ID */
  backendNodeId: number;
}

/**
 * DOM Node Type Constants (from W3C DOM specification)
 * https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
 */
export const NODE_TYPE_ELEMENT = 1;
export const NODE_TYPE_ATTRIBUTE = 2;
export const NODE_TYPE_TEXT = 3;
export const NODE_TYPE_CDATA_SECTION = 4;
export const NODE_TYPE_ENTITY_REFERENCE = 5; // Deprecated
export const NODE_TYPE_ENTITY = 6; // Deprecated
export const NODE_TYPE_PROCESSING_INSTRUCTION = 7;
export const NODE_TYPE_COMMENT = 8;
export const NODE_TYPE_DOCUMENT = 9;
export const NODE_TYPE_DOCUMENT_TYPE = 10;
export const NODE_TYPE_DOCUMENT_FRAGMENT = 11;
export const NODE_TYPE_NOTATION = 12; // Deprecated

// Core tree node
export interface VirtualNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: VirtualNode[];
  shadowRoots?: VirtualNode[];
  contentDocument?: VirtualNode;
  frameId?: string;
  shadowRootType?: 'open' | 'closed';

  // Frame identification for multi-frame support
  frameIndex?: number;  // 0 for main frame, 1-5 for iframes

  accessibility?: {
    role: string;
    name?: string;
    description?: string;
    value?: string | number;
    checked?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    level?: number;
    required?: boolean;
  };

  tier: 'semantic' | 'non-semantic' | 'structural';
  interactionType?: 'click' | 'input' | 'select' | 'link';

  heuristics?: {
    hasOnClick: boolean;
    hasDataTestId: boolean;
    hasCursorPointer: boolean;
    isVisuallyInteractive: boolean;
  };

  // Bounding box in CSS pixels (normalized from CDP device pixels in DomService)
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // NEW: Paint order for occlusion detection (F5)
  paintOrder?: number;

  // NEW: Computed styles for visibility checks (F5)
  computedStyle?: {
    opacity?: string;
    backgroundColor?: string;
    display?: string;
    visibility?: string;
    cursor?: string;
    overflowX?: string;
    overflowY?: string;
  };

  // NEW: Scroll dimensions for scrollability detection
  scrollRects?: {
    width: number;
    height: number;
  };

  clientRects?: {
    width: number;
    height: number;
  };

  // NEW: Scrollability indicator for LLM to identify scroll targets
  scrollable?: 'vertical' | 'horizontal' | 'vertical and horizontal';

  // NEW: Filtering flags
  ignoredByPaintOrder?: boolean;  // F5: Paint Order Filtering
  excludedByParent?: boolean;     // S2.4: Propagating Bounds
}

// Snapshot cache
export interface DomSnapshot {
  virtualDom: VirtualNode;
  timestamp: Date;
  pageContext: PageContext;
  stats: SnapshotStats;
}

export interface PageContext {
  url: string;
  title: string;
  frameId: string;
  loaderId: string;
  // Viewport dimensions in CSS pixels (web standard)
  // devicePixelRatio is captured for diagnostics but coordinates are pre-normalized to CSS pixels
  viewport: {
    width: number;
    height: number;
    scrollX?: number;
    scrollY?: number;
    pageWidth?: number;
    pageHeight?: number;
    devicePixelRatio?: number;
  };
  frameTree: FrameNode[];
  frameworkDetected?: string | null; // Detected framework (react, vue, angular, etc.)
}

export interface FrameNode {
  frameId: string;
  url: string;
  parentFrameId?: string;
  childFrames?: FrameNode[];
}

export interface SnapshotStats {
  totalNodes: number;
  interactiveNodes: number;
  semanticNodes: number;
  nonSemanticNodes: number;
  structuralNodes: number;
  frameCount: number;
  shadowRootCount: number;
  snapshotDuration: number;
  serializationDuration?: number;
}

export interface FrameInfo {
  frameId: string;
  url: string;
  isMainFrame: boolean;
  parentFrameId?: string;
}

// Service config
export interface ServiceConfig {
  enableVisualEffects: boolean;
  maxTreeDepth: number;
  snapshotTimeout: number;
  retryAttempts: number;
  enableMetrics?: boolean; // Enable performance metrics collection
}

// Performance metrics interface
export interface PerformanceMetrics {
  snapshotCount: number;
  snapshotCacheHits: number;
  snapshotCacheMisses: number;
  totalSnapshotDuration: number;
  averageSnapshotDuration: number;
  actionCount: number;
  actionsByType: {
    click: number;
    type: number;
    scroll: number;
    keypress: number;
  };
  totalActionDuration: number;
  averageActionDuration: number;
  errorCount: number;
  errorsByType: Record<string, number>;
  lastReset: Date;
}

/**
 * Type definitions for DOM serialization pipeline
 *
 * This section contains TypeScript interfaces and types used throughout
 * the three-stage serialization pipeline (Signal Filtering → Structure
 * Simplification → Payload Optimization).
 */

/**
 * Result of serialization pipeline execution
 */
export interface SerializationResult {
  // Filtered and simplified VirtualNode tree (still needs serialization to SerializedNode)
  tree: VirtualNode;

  // ID remapper for action translation
  idRemapper: IIdRemapper;

  // Compaction metrics (if enabled)
  metrics?: CompactionMetrics;

  // Warnings/errors during serialization
  warnings?: string[];
}

/**
 * Configuration options for serialization pipeline
 */
export interface PipelineConfig {
  // Stage 1: Signal Filtering
  enableVisibilityFilter: boolean;        // F1: Remove hidden elements
  enableTextNodeFilter: boolean;          // F2: Remove tiny text nodes
  enableNoiseFilter: boolean;             // F3: Remove script/style/meta
  enableSemanticContainerFilter: boolean; // F4: Require interactive descendants
  enablePaintOrderFilter: boolean;        // F5: Remove obscured elements

  // Stage 2: Structure Simplification
  enableTextCollapsing: boolean;          // S2.1: Merge consecutive text
  enableLayoutSimplification: boolean;    // S2.2: Collapse wrappers & hoist containers
  enableClickableTextAggregation: boolean; // S2.3: Aggregate nested text in clickables
  enableAriaLabelCleaning: boolean;       // S2.4: Remove aria-labels from text nodes
  enableAttributeDeduplication: boolean;  // S2.5: Remove redundant attributes
  enablePropagatingBounds: boolean;       // S2.6: Remove nested clickables

  // Stage 3: Payload Optimization
  enableIdRemapping: boolean;             // P3.1: Sequential IDs
  enableAttributePruning: boolean;        // P3.2: Keep only semantic attrs
  enableFieldNormalization: boolean;      // P3.3: Snake_case field names
  enableNumericCompaction: boolean;       // P3.4: Compact bboxes
  enableMetadataBucketing: boolean;       // P3.5: Collection-level states

  // General settings
  maxDepth: number;                       // Max tree depth (prevent stack overflow)
  minTextLength: number;                  // Min chars for text nodes (default: 2)
  propagatingContainmentThreshold: number; // Containment % for nested clickables (default: 0.99)
  enableMetrics: boolean;                 // Track compaction metrics
  enableCache: boolean;                   // Enable clickable detection caching
}

/**
 * Default pipeline configuration (all features enabled)
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  // Stage 1: Signal Filtering
  enableVisibilityFilter: true,
  enableTextNodeFilter: true,
  enableNoiseFilter: true,
  enableSemanticContainerFilter: true,
  enablePaintOrderFilter: false,  // Disabled by default due to buggy algorithm

  // Stage 2: Structure Simplification
  enableTextCollapsing: true,
  enableLayoutSimplification: true,
  enableClickableTextAggregation: true,
  enableAriaLabelCleaning: true,
  enableAttributeDeduplication: true,
  enablePropagatingBounds: true,

  // Stage 3: Payload Optimization
  enableIdRemapping: false, // Disabled: use backendNodeId directly
  enableAttributePruning: true,
  enableFieldNormalization: true,
  enableNumericCompaction: true,
  enableMetadataBucketing: true,

  // General settings
  maxDepth: 100,
  minTextLength: 2,
  propagatingContainmentThreshold: 0.99,
  enableMetrics: true,
  enableCache: true,
};

/**
 * Baseline configuration (all optimizations disabled)
 * Use for comparison testing
 */
export const BASELINE_PIPELINE_CONFIG: PipelineConfig = {
  enableVisibilityFilter: false,
  enableTextNodeFilter: false,
  enableNoiseFilter: false,
  enableSemanticContainerFilter: false,
  enablePaintOrderFilter: false,
  enableTextCollapsing: false,
  enableLayoutSimplification: false,
  enableAttributeDeduplication: false,
  enablePropagatingBounds: false,
  enableIdRemapping: false,
  enableAttributePruning: false,
  enableFieldNormalization: false,
  enableNumericCompaction: false,
  enableMetadataBucketing: false,
  maxDepth: 100,
  minTextLength: 2,
  propagatingContainmentThreshold: 0.99,
  enableMetrics: true,
  enableCache: false,
};

/**
 * Rectangle primitive for geometric operations
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Layout data extracted from DOMSnapshot.captureSnapshot()
 * Contains positional and visual information for DOM nodes
 *
 * NOTE: CDP returns coordinates in device pixels, but we normalize to CSS pixels
 * for consistency with standard web APIs (getBoundingClientRect, window.innerWidth, etc.)
 */
export interface LayoutData {
  // Bounding box in CSS pixels (normalized from CDP device pixels)
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // Paint order for occlusion detection (higher values are painted on top)
  paintOrder?: number;

  // Computed CSS styles
  computedStyle?: {
    opacity?: string;
    backgroundColor?: string;
    display?: string;
    visibility?: string;
    cursor?: string;
    overflowX?: string;
    overflowY?: string;
  };

  // Scroll dimensions (scrollable content size)
  scrollRects?: {
    width: number;
    height: number;
  };

  // Client dimensions (visible viewport size)
  clientRects?: {
    width: number;
    height: number;
  };
}

/**
 * ID remapper interface for bidirectional mapping
 */
export interface IIdRemapper {
  registerNode(backendNodeId: number): number;
  toBackendId(sequentialId: number): number | null;
  toSequentialId(backendNodeId: number): number | null;
  hasBackendId(backendNodeId: number): boolean;
  getNodeCount(): number;
}

/**
 * Compaction metrics for instrumentation
 */
export interface CompactionMetrics {
  // Node counts
  totalNodes: number;
  interactiveNodes: number;
  structuralNodes: number;
  filteredNodes: number;
  serializedNodes: number;

  // Token metrics
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  tokenReductionRate: number;

  // Character counts
  totalCharsBefore: number;
  totalCharsAfter: number;
  averageCharsPerNode: number;

  // Performance
  serializationTimeMs: number;
  stage1TimeMs: number;
  stage2TimeMs: number;
  stage3TimeMs: number;

  // Stage-specific metrics
  visibilityFiltered: number;
  textNodesFiltered: number;
  noiseFiltered: number;
  containersFiltered: number;
  paintOrderFiltered: number;
  propagatingBoundsFiltered: number;

  // Compaction score
  compactionScore: number;
}

/**
 * Base interface for all filters
 */
export interface IFilter {
  shouldKeep(node: VirtualNode, parent: VirtualNode | null): boolean;
  getName(): string;
}

/**
 * Base interface for all simplifiers
 */
export interface ISimplifier {
  simplify(node: VirtualNode): VirtualNode;
  getName(): string;
}

/**
 * Base interface for all optimizers
 */
export interface IOptimizer {
  optimize(node: SerializedNode): SerializedNode;
  getName(): string;
}
