# DOM Serializers

A three-stage pipeline architecture for optimizing DOM tree serialization to reduce token consumption for LLM-based browser automation.

## Overview

The DOM serialization pipeline transforms large, complex DOM trees into compact, token-efficient representations while preserving all interactive and semantically meaningful content. The pipeline achieves 40-80% token reduction through systematic filtering, simplification, and optimization.

## Architecture

### Pipeline Stages

The serialization process operates in three distinct stages, orchestrated by [SerializationPipeline.ts](SerializationPipeline.ts):

```
┌─────────────────────────────────────────────────────────────┐
│                   Stage 1: Signal Filtering                 │
│  Remove invisible, noise, and non-interactive elements      │
│  ▸ VisibilityFilter  ▸ TextNodeFilter  ▸ NoiseFilter       │
│  ▸ SemanticContainerFilter  ▸ PaintOrderFilter              │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│              Stage 2: Structure Simplification              │
│  Collapse wrappers, merge text, deduplicate attributes      │
│  ▸ TextCollapser  ▸ LayoutSimplifier                        │
│  ▸ AttributeDeduplicator  ▸ PropagatingBoundsFilter         │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│               Stage 3: Payload Optimization                 │
│  Sequential ID mapping, attribute pruning, compact encoding │
│  ▸ IdRemapper  ▸ AttributePruner  ▸ FieldNormalizer        │
│  ▸ NumericCompactor  ▸ MetadataBucketer                     │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

- **[SerializationPipeline.ts](SerializationPipeline.ts)**: Main orchestrator that executes all three stages
- **[CompactionMetrics.ts](CompactionMetrics.ts)**: Tracks token reduction, performance, and compaction scores

## Stage 1: Signal Filtering

Removes elements that don't contribute to interactive or semantic meaning.

### Filters

#### [VisibilityFilter.ts](filters/VisibilityFilter.ts) (F1)

Removes hidden and invisible elements:
- Zero bounding box (width = 0 or height = 0)
- `aria-hidden="true"` (except dialogs/modals)
- `display: none`
- `visibility: hidden`
- `opacity: 0`

**Exception**: Dialog/modal elements are preserved even if `aria-hidden`, as they may contain interactive content that becomes visible.

```typescript
// Example
if (node.boundingBox?.width === 0 || node.boundingBox?.height === 0) {
  // Remove - not visible to user
}
```

#### [TextNodeFilter.ts](filters/TextNodeFilter.ts) (F2)

Removes tiny text nodes (< 2 characters), unless:
- Parent element is interactive (semantic or non-semantic tier)
- Text contains meaningful whitespace (tabs, newlines)

**Rationale**: Single-character text nodes are often layout artifacts with no semantic value.

```typescript
// Example
if (node.nodeType === TEXT_NODE && node.nodeValue.trim().length < 2) {
  // Remove unless parent is interactive
}
```

#### [NoiseFilter.ts](filters/NoiseFilter.ts) (F3)

Removes elements with no user-visible content:
- `<script>`: JavaScript code
- `<style>`: CSS styling
- `<noscript>`: Fallback content
- `<meta>`: Document metadata
- `<link>`: External resources
- HTML comments

```typescript
const noiseTags = ['script', 'style', 'noscript', 'meta', 'link', 'base', 'title'];
```

#### [SemanticContainerFilter.ts](filters/SemanticContainerFilter.ts) (F4)

Requires semantic containers to have interactive descendants. Removes pure structural wrappers that contain no interactive elements.

**Preserved containers**: `form`, `table`, `dialog`, `nav`, `header`, `footer`, `main`, `article`, `section`

#### [PaintOrderFilter.ts](filters/PaintOrderFilter.ts) (F5)

Removes elements obscured by others in the visual z-order. Uses paint order metadata to detect overlapping elements.

## Stage 2: Structure Simplification

Collapses redundant structural elements while preserving semantic relationships.

### Simplifiers

#### [TextCollapser.ts](simplifiers/TextCollapser.ts) (S2.1)

Merges consecutive text nodes into a single node:

```typescript
// Before:
<p>
  #text("Hello ")
  #text("world")
</p>

// After:
<p>
  #text("Hello world")
</p>
```

**Rules**:
- Only merges direct sibling text nodes
- Preserves whitespace (concatenates as-is)
- Does not merge across element boundaries

#### [LayoutSimplifier.ts](simplifiers/LayoutSimplifier.ts) (S2.2)

Collapses single-child wrapper elements by hoisting the child:

```typescript
// Before:
<div class="wrapper">
  <button id="submit">Click me</button>
</div>

// After:
<button id="submit" class="wrapper">Click me</button>
```

**Rules**:
- Only collapses structural (non-interactive) wrappers
- Preserves semantic containers (`form`, `table`, `dialog`, etc.)
- Hoists important attributes (`id`, `class`, `data-*`) to child
- Child attributes take precedence on conflicts

#### [AttributeDeduplicator.ts](simplifiers/AttributeDeduplicator.ts) (S2.3)

Removes redundant attributes inherited from parent elements. Propagates attributes down the tree to avoid repetition.

#### [PropagatingBoundsFilter.ts](simplifiers/PropagatingBoundsFilter.ts) (S2.4)

Removes nested clickable elements when parent is also clickable and contains child bounds. Prevents duplicate click targets.

**Configuration**: `propagatingContainmentThreshold` (default: 0.95) - minimum overlap ratio to consider containment.

## Stage 3: Payload Optimization

Applies token-level optimizations for compact encoding.

### Optimizers

#### [IdRemapper.ts](optimizers/IdRemapper.ts) (P3.1)

Maps large CDP backend node IDs (e.g., 52819) to sequential IDs (1, 2, 3...) for token optimization. Maintains bidirectional mapping for action translation.

```typescript
class IdRemapper {
  registerNode(backendNodeId: number): number;  // Returns sequential ID
  toBackendId(sequentialId: number): number | null;  // For actions
  toSequentialId(backendNodeId: number): number | null;  // For serialization
}
```

**Lifecycle**:
1. Created during serialization
2. Registers nodes as they're serialized
3. Persists in DomSnapshot for action translation
4. Regenerated on snapshot rebuild after invalidation

#### [AttributePruner.ts](optimizers/AttributePruner.ts) (P3.2)

Keeps only semantic attributes, removing:
- Style attributes (`style`, `class`)
- Event handlers (`onclick`, `onchange`)
- Layout attributes (`width`, `height` - redundant with boundingBox)

**Preserved attributes**:
- Semantic: `id`, `name`, `href`, `value`, `placeholder`, `type`, `title`
- ARIA: All `aria-*` attributes
- Data: All `data-*` attributes (useful for testing/identification)
- Form: `disabled`, `readonly`, `required`, `checked`, `selected`

#### [FieldNormalizer.ts](optimizers/FieldNormalizer.ts) (P3.3)

Normalizes field names to snake_case for compact serialization. Applied during final JSON serialization, not tree transformation.

**Example**:
```typescript
// Before: { boundingBox: { ... } }
// After: { bounding_box: { ... } }
```

#### [NumericCompactor.ts](optimizers/NumericCompactor.ts) (P3.4)

Compacts bounding boxes to integer arrays:

```typescript
// Before: { x: 100.5, y: 200.3, width: 50.2, height: 30.1 }
// After: [100, 200, 50, 30]
```

**Optimizations**:
- Round floats to integers (pixel precision sufficient)
- Use array notation instead of object (less verbose)

#### [MetadataBucketer.ts](optimizers/MetadataBucketer.ts) (P3.5)

Groups common metadata (roles, types) into collection-level dictionaries. Applied during final serialization.

## Utilities

### [ClickableCache.ts](utils/ClickableCache.ts)

Caches interactive element detection results for 40-60% speedup during pipeline execution. Cache is cleared on snapshot invalidation.

**Detection logic considers**:
- Tier classification (semantic, non-semantic)
- Interaction type (click, input, select, link)
- Heuristics (onclick, data-testid, cursor:pointer)
- Accessibility role

```typescript
class ClickableCache {
  isClickable(node: VirtualNode): boolean;
  clear(): void;
  getStats(): { hits: number; misses: number; size: number };
}
```

### [RectUnion.ts](utils/RectUnion.ts)

Computes bounding rectangle unions for nested elements. Used by PropagatingBoundsFilter and PaintOrderFilter.

## Configuration

All stages and individual components are configurable via [PipelineConfig](../types.ts):

```typescript
interface PipelineConfig {
  // Stage 1: Signal Filtering
  enableVisibilityFilter: boolean;          // Default: true
  enableTextNodeFilter: boolean;            // Default: true
  enableNoiseFilter: boolean;               // Default: true
  enableSemanticContainerFilter: boolean;   // Default: true
  enablePaintOrderFilter: boolean;          // Default: true

  // Stage 2: Structure Simplification
  enableTextCollapsing: boolean;            // Default: true
  enableLayoutSimplification: boolean;      // Default: true
  enableAttributeDeduplication: boolean;    // Default: true
  enablePropagatingBounds: boolean;         // Default: true

  // Stage 3: Payload Optimization
  enableIdRemapping: boolean;               // Default: true
  enableAttributePruning: boolean;          // Default: true
  enableFieldNormalization: boolean;        // Default: true
  enableNumericCompaction: boolean;         // Default: true
  enableMetadataBucketing: boolean;         // Default: true

  // Thresholds
  minTextLength: number;                    // Default: 2
  propagatingContainmentThreshold: number;  // Default: 0.95
}
```

## Metrics and Performance

### CompactionMetrics

Tracks comprehensive metrics across all pipeline stages:

```typescript
interface CompactionMetrics {
  // Node counts
  totalNodes: number;
  interactiveNodes: number;
  structuralNodes: number;
  filteredNodes: number;
  serializedNodes: number;

  // Token metrics
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  tokenReductionRate: number;  // 0.0 to 1.0

  // Character counts
  totalCharsBefore: number;
  totalCharsAfter: number;
  averageCharsPerNode: number;

  // Performance timing
  serializationTimeMs: number;
  stage1TimeMs: number;  // Signal Filtering
  stage2TimeMs: number;  // Structure Simplification
  stage3TimeMs: number;  // Payload Optimization

  // Stage-specific metrics
  visibilityFiltered: number;
  textNodesFiltered: number;
  noiseFiltered: number;
  containersFiltered: number;
  paintOrderFiltered: number;
  propagatingBoundsFiltered: number;

  // Overall score
  compactionScore: number;  // Weighted score (0.0 to 1.0)
}
```

### Compaction Score Formula

```typescript
compactionScore =
  0.4 × textReduction +
  0.4 × nodeReduction +
  0.2 × metadataReduction
```

Where:
- **textReduction**: `(charsBefore - charsAfter) / charsBefore`
- **nodeReduction**: `(totalNodes - serializedNodes) / totalNodes`
- **metadataReduction**: `tokenReductionRate`

### Token Estimation

Uses approximate rate: **1 token ≈ 3.8 characters** (typical for English text)

```typescript
static estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 3.8);
}
```

## Usage Example

```typescript
import { SerializationPipeline } from './SerializationPipeline';
import { VirtualNode } from '../types';

// Create pipeline with custom config
const pipeline = new SerializationPipeline({
  enableVisibilityFilter: true,
  enableLayoutSimplification: true,
  minTextLength: 3,
  propagatingContainmentThreshold: 0.90
});

// Execute pipeline on virtual DOM tree
const result = pipeline.execute(virtualDomTree);

// Access results
console.log('Optimized tree:', result.tree);
console.log('Metrics:', result.metrics.toString());
console.log('Token reduction:', result.metrics.tokenReductionRate * 100 + '%');

// Use ID remapper for action translation
const backendNodeId = result.idRemapper.toBackendId(sequentialId);
```

## Integration with DomService

The serialization pipeline is integrated into the [DomService](../DomService.ts) CDP implementation:

1. **Snapshot Build**: DomService builds VirtualNode tree from CDP DOM + Accessibility trees
2. **Pipeline Execution**: SerializationPipeline optimizes the tree
3. **ID Mapping**: IdRemapper translates sequential IDs ↔ CDP backend node IDs
4. **Action Translation**: Actions from LLM use sequential IDs, resolved to backend IDs via IdRemapper
5. **Cache Management**: ClickableCache and snapshot invalidated after actions

See [CONTRACTS.md](../CONTRACTS.md) for detailed DOMTool-DomService contracts.

## Performance Characteristics

### Typical Reduction Rates

- **Token Reduction**: 40-80% (depending on page complexity)
- **Node Reduction**: 50-70% (structural elements filtered)
- **Character Reduction**: 35-65% (attribute pruning, numeric compaction)

### Timing

- **Stage 1 (Filtering)**: 30-40% of total time
- **Stage 2 (Simplification)**: 25-35% of total time
- **Stage 3 (Optimization)**: 25-35% of total time
- **Total Pipeline**: Typically 10-50ms for medium-sized pages (1000-5000 nodes)

### Memory Overhead

- Pipeline creates a deep copy of the tree before transformation
- IdRemapper maintains two bidirectional maps (minimal overhead)
- ClickableCache stores boolean per node (~1KB per 1000 nodes)

## Testing

Each component has corresponding unit tests:

```bash
# Run all serializer tests
npm test -- src/tools/dom/serializers

# Run specific stage tests
npm test -- filters/VisibilityFilter.test.ts
npm test -- simplifiers/TextCollapser.test.ts
npm test -- optimizers/IdRemapper.test.ts
```

### Test Coverage Requirements

- All filters: 90%+ coverage
- All simplifiers: 90%+ coverage
- All optimizers: 90%+ coverage
- SerializationPipeline: 85%+ coverage
- Integration tests: All contracts validated

## Design Principles

1. **Deterministic**: Pipeline produces same output for same input (no randomness)
2. **Composable**: Each stage operates independently, can be enabled/disabled
3. **Non-destructive**: Pipeline never mutates input tree (creates deep copy)
4. **Semantic Preservation**: All interactive and semantically meaningful content preserved
5. **Metrics-driven**: Comprehensive instrumentation for optimization analysis
6. **Bidirectional Mapping**: ID remapping supports round-trip translation for actions

## Future Optimizations

### Potential Enhancements

- **Incremental Serialization**: Cache subtrees and update only changed portions
- **Adaptive Thresholds**: Auto-tune filtering thresholds based on page characteristics
- **Parallel Processing**: Process independent subtrees in parallel (Web Workers)
- **Streaming Serialization**: Stream output as tree is processed (reduce memory)
- **ML-based Filtering**: Train model to predict interactive elements more accurately

### Known Limitations

- **Static Analysis Only**: Cannot detect dynamic interactivity added by JavaScript at runtime
- **Heuristic-based**: Non-semantic tier detection relies on heuristics (may have false positives/negatives)
- **Deep Copy Cost**: Tree cloning has O(n) memory overhead
- **Single-threaded**: Pipeline execution is synchronous (blocks main thread)

## Related Documentation

- [../CONTRACTS.md](../CONTRACTS.md): DOMTool-DomService contracts
- [../types.ts](../types.ts): Type definitions for VirtualNode, PipelineConfig
- [../DomService.ts](../DomService.ts): CDP-based DOM service implementation
- [../README.md](../README.md): DOM tools overview

## Version History

- **v1.0.0** (2025-10-30): Initial three-stage pipeline implementation
