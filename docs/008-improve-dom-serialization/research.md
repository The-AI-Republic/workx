# Research: Improved DOM Serialization

**Feature**: 008-improve-dom-serialization
**Date**: 2025-11-07

## Overview

This document consolidates research findings and design decisions for optimizing the DOM serialization pipeline to reduce LLM token consumption by 30%+ while preserving semantic relationships.

## R-001: Container Hoisting Strategy

### Decision
Implement container hoisting as enhancement to existing `LayoutSimplifier`

### Rationale
1. **Code Reuse**: `LayoutSimplifier` already handles wrapper collapsing logic
2. **Single Responsibility**: Centralizes all layout-related simplification in one place
3. **Maintenance**: Fewer classes to maintain for similar functionality

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Create new `ContainerHoister` simplifier | Clean separation of concerns | Overlapping responsibility with LayoutSimplifier | Duplicates existing wrapper logic |
| Implement in filter stage | Earlier in pipeline | Hoisting is transformation, not filtering | Violates pipeline architecture |
| Implement in `buildSerializedNode()` | No new classes needed | Mixes serialization with transformation | Poor separation of concerns |

### Implementation Approach

**Meaningless Container Detection**:
```typescript
function isMeaninglessContainer(node: VirtualNode): boolean {
  // Must be a div
  if (node.localName !== 'div') return false;

  // Must have generic or no role
  const role = node.accessibility?.role;
  if (role && role !== 'generic') return false;

  // Must have exactly one child (hoisting candidate)
  if (!node.children || node.children.length !== 1) return false;

  // Must not have semantic attributes
  if (node.accessibility?.name) return false;

  return true;
}
```

**Semantic Container Preservation**:
```typescript
const SEMANTIC_ROLES = [
  'form', 'table', 'dialog', 'navigation',
  'main', 'region', 'article', 'section'
];

function isSemanticContainer(node: VirtualNode): boolean {
  const role = node.accessibility?.role;
  return role && SEMANTIC_ROLES.includes(role);
}
```

**Recursive Hoisting Logic**:
```typescript
// Bypass chain of meaningless containers
function hoistChildren(node: VirtualNode): VirtualNode {
  while (isMeaninglessContainer(node) && node.children) {
    node = node.children[0]; // Hoist child up one level
  }
  return node;
}
```

---

## R-002: Clickable Text Aggregation Pattern

### Decision
Create new `ClickableTextAggregator` simplifier in Stage 2 (Structure Simplification)

### Rationale
1. **Pipeline Fit**: Text aggregation is structural transformation (not filtering or optimization)
2. **Independence**: Requires deep tree traversal independent of other simplifiers
3. **Reusability**: Could be toggled on/off via configuration

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Implement in `buildSerializedNode()` | No new class | Mixes serialization with transformation | Violates single responsibility |
| Implement in `TextCollapser` | Reuses existing class | TextCollapser merges siblings, not descendants | Different operation semantics |
| Implement in DomSnapshot | Central location | Breaks separation of concerns | Snapshot should orchestrate, not transform |

### Implementation Approach

**Clickable Element Detection**:
```typescript
function isClickable(node: VirtualNode): boolean {
  // Check interaction type
  if (node.interactionType === 'click' || node.interactionType === 'link') {
    return true;
  }

  // Check accessibility role
  const clickableRoles = ['button', 'link', 'tab', 'menuitem'];
  if (node.accessibility?.role && clickableRoles.includes(node.accessibility.role)) {
    return true;
  }

  // Check HTML tag
  const tag = node.localName?.toLowerCase();
  if (tag === 'a' || tag === 'button') {
    return true;
  }

  return false;
}
```

**Text Aggregation Logic**:
```typescript
function aggregateText(node: VirtualNode): string {
  const texts: string[] = [];

  function traverse(n: VirtualNode) {
    // Skip invisible elements
    if (n.computedStyle?.display === 'none' ||
        n.computedStyle?.visibility === 'hidden') {
      return;
    }

    // Extract text from text nodes
    if (n.nodeType === NODE_TYPE_TEXT && n.nodeValue) {
      texts.push(n.nodeValue.trim());
    }

    // Recurse to children
    if (n.children) {
      n.children.forEach(traverse);
    }
  }

  traverse(node);
  return texts.join(' ').trim();
}
```

**Child Replacement Strategy**:
```typescript
// Option 1: Empty children array
node.children = [];

// Option 2: Single text node with aggregated value (preferred)
node.children = [{
  nodeType: NODE_TYPE_TEXT,
  nodeValue: aggregatedText,
  // ... other required fields
}];
```

---

## R-003: Aria-Label Removal Strategy

### Decision
Create new `AriaLabelCleaner` simplifier in Stage 2

### Rationale
1. **Simplicity**: Simple conditional logic (if text node, remove aria_label)
2. **Independence**: Separate concern from other simplifiers
3. **Configurability**: Can be toggled on/off independently

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Implement in `buildSerializedNode()` | No new class | Pollutes serialization logic | Violates separation of concerns |
| Implement in `AttributeDeduplicator` | Reuses existing class | Deduplicator removes duplicates, not all instances | Different operation semantics |
| Check during serialization | Inline logic | Hard to test independently | Poor testability |

### Implementation Approach

**Text Node Aria-Label Removal**:
```typescript
function cleanAriaLabels(node: VirtualNode): VirtualNode {
  // Only remove from text nodes
  if (node.nodeType === NODE_TYPE_TEXT) {
    if (node.accessibility?.name) {
      // Remove aria-label from text node
      delete node.accessibility.name;
    }
  }

  // Recurse to children
  if (node.children) {
    node.children = node.children.map(cleanAriaLabels);
  }

  return node;
}
```

**Parent Aria-Label Scope Limitation**:
```typescript
// Use only element's own accessibility.name from CDP
// Do NOT aggregate child aria-labels into parent
// CDP Accessibility tree already provides correct scoping
```

**Edge Cases**:
- **Empty text nodes**: Still remove aria-label (redundant with parent's label)
- **Icon-only elements**: Preserve aria-label on parent element (not text node)
- **Nested text nodes**: Each text node processed independently

---

## R-004: Text Node Tag Elimination

### Decision
Modify `serializedNodeToHtml()` utility function to render text inline without `<#text>` wrapper tags

### Rationale
1. **Presentation Layer**: This is output formatting concern, not data structure
2. **No Breaking Changes**: SerializedNode structure remains unchanged
3. **Simplicity**: Single function modification vs structural refactoring

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Change SerializedNode structure | Eliminates text nodes entirely | Breaking change for internal consumers | Too invasive |
| Create separate HTML renderer | Clean separation | YAGNI - current renderer sufficient | Over-engineering |
| Add configuration flag | Backward compatible | Adds complexity | Feature not needed in both modes |

### Implementation Approach

**Current Behavior**:
```html
<button data-node-id="123">
  <#text data-node-id="124" role="StaticText">Click me</#text>
</button>
```

**New Behavior**:
```html
<button data-node-id="123">Click me</button>
```

**Implementation**:
```typescript
function serializedNodeToHtml(node: SerializedNode, indent: number = 0): string {
  // If this is a text node, return plain text (no wrapper tag)
  if (node.tag === '#text') {
    return escapeHtml(node.text || '');
  }

  // For element nodes, render children inline
  // ... existing element rendering logic
}
```

---

## R-005: Data-TestId Field Addition

### Decision
Add `testid?: string` field to SerializedNode interface, map to `data-testid` attribute in HTML output

### Rationale
1. **Backward Compatible**: Additive change only (optional field)
2. **Clean TypeScript Access**: Use `node.testid` instead of `node["data-testid"]`
3. **Type Safe**: Direct field access vs generic attributes object
4. **Consistent**: Matches existing pattern for href, input_type, hint
5. **Preserves HTML Attribute**: HTML output uses original `data-testid` name

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Use quoted `"data-testid"` field | Preserves exact attribute name | Awkward access: `node["data-testid"]` | Poor developer experience |
| Normalize to `test_id` | No quoting needed | Both quotes and naming mismatch | Still inconsistent with HTML |
| Store in generic `attributes` object | No schema change | Loses type safety | Harder to access programmatically |
| Ignore data-testid | No code changes | Loses useful automation signal | Low implementation cost justifies inclusion |

### Implementation Approach

**Type Definition** (types.ts):
```typescript
export interface SerializedNode {
  node_id: number;
  tag: string;
  role?: string;
  aria_label?: string;
  text?: string;
  href?: string;
  input_type?: string;
  hint?: string;
  testid?: string;  // NEW - from data-testid HTML attribute
  bbox?: [number, number, number, number];
  states?: Record<string, boolean | string>;
  kids?: SerializedNode[];
}
```

**Extraction** (DomSnapshot.ts - buildSerializedNode):
```typescript
// Extract data-testid from attribute map, store as testid
if (attrMap.has('data-testid')) {
  serializedNode.testid = attrMap.get('data-testid');
}
```

**HTML Output** (utils.ts - serializedNodeToHtml):
```typescript
// Map testid back to data-testid HTML attribute
if (node.testid) {
  attributes.push(`data-testid="${escapeHtml(node.testid)}"`);
}
```

---

## R-006: Performance Optimization Strategy

### Decision
Use single-pass tree traversal for all simplifiers (sequential execution within Stage 2)

### Rationale
1. **Existing Pattern**: SerializationPipeline already supports multiple simplifiers
2. **O(n) Complexity**: Each simplifier operates once, modifications accumulate
3. **Separation of Concerns**: Each simplifier focuses on single transformation

### Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Multi-pass (one pass per simplifier) | Simple implementation | O(n*m) complexity where m=simplifiers | Performance unacceptable |
| Combined single simplifier | O(n) single pass | Violates separation of concerns | Hard to test/maintain |
| Lazy evaluation | Optimizes unused paths | Complex implementation | YAGNI |

### Implementation Approach

**Execution Order** (Stage 2 simplifiers):
1. `TextCollapser` - Merge consecutive text nodes
2. `LayoutSimplifier` - Collapse wrappers + hoist containers (enhanced)
3. `ClickableTextAggregator` - Aggregate text in clickable elements (new)
4. `AriaLabelCleaner` - Remove text node aria-labels (new)

**Performance Characteristics**:
- **Stage 1 (Filters)**: 4-5 passes (existing)
- **Stage 2 (Simplifiers)**: 4 passes (2 existing + 2 new)
- **Stage 3 (Optimizers)**: 3-4 passes (existing)
- **Total**: ~11-13 tree traversals
- **Complexity**: O(n * passes) where n = node count

**Optimization Techniques**:
- Early exit: Skip non-applicable nodes in each simplifier
- In-place modification: Avoid tree copying
- Cached lookups: Reuse clickable detection results

---

## R-007: Test Strategy

### Decision
Hybrid approach: Add test cases to existing files + create new test files for new simplifiers

### Rationale
1. **Regression Testing**: Existing 16 test files cover integration scenarios
2. **Unit Testing**: New simplifiers need dedicated isolated tests
3. **Realistic Fixtures**: X.com samples validate real-world performance

### Test Coverage Plan

| Test File | Type | Cases | Purpose |
|-----------|------|-------|---------|
| DomSnapshot.test.ts | Integration | +5 | End-to-end serialization with new features |
| utils.test.ts | Unit | +8 | Modified `serializedNodeToHtml()` function |
| ClickableTextAggregator.test.ts | Unit | 10-15 | Text aggregation edge cases |
| AriaLabelCleaner.test.ts | Unit | 8-10 | Aria-label removal logic |
| LayoutSimplifier.test.ts | Unit | +10 | Container hoisting (if file doesn't exist) |
| integration.*.test.ts | Integration | 0 (verify) | Existing 71/77 tests continue passing |

### Test Fixtures

**X.com DOM Samples** (add to `tests/tools/dom/fixtures/`):
1. **nested-divs.html**: 7+ level div nesting with single textbox child
2. **clickable-nested-text.html**: Links with 4 nested spans containing text
3. **aria-label-text-nodes.html**: Text nodes with duplicate aria-labels
4. **icon-only-button.html**: Button with only image child and aria-label
5. **semantic-containers.html**: Form/navigation/main containers (preserve)

### Success Criteria Validation

| Criterion | Test Method | Automation |
|-----------|-------------|------------|
| SC-001: 30% token reduction | Compare JSON.stringify(before).length vs after | Automated benchmark |
| SC-002: Max 8 nesting levels | Measure tree depth in serialized output | Automated assertion |
| SC-003: 100% clickable aggregation | Scan for nested spans in clickable elements | Automated assertion |
| SC-004: 100% text aria-label removal | Grep for aria_label in text nodes | Automated assertion |
| SC-005: <10% performance overhead | Benchmark serialization time | Automated benchmark |
| SC-006: 100% test pass rate | Run `npm test` | CI/CD |
| SC-007: Manual quality check | Review 5 sites output | Manual review |

---

## Technology Stack

### Existing Dependencies (No Changes)
- **TypeScript 5.9.2**: Strict type safety, ES2020 target
- **Vitest 3.2.4**: Test runner with Chrome Mock
- **Svelte 4.2.20**: UI framework (not used in DOM tool)
- **Chrome Extension APIs**: CDP, Storage, Debugger

### No New Dependencies Required
All changes use existing TypeScript/Chrome APIs. No external libraries needed.

---

## Performance Budgets

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Serialization time (1000 nodes) | ~100ms | <110ms | Vitest benchmark |
| Token count (X.com homepage) | ~15KB JSON | <10.5KB JSON | JSON.stringify().length |
| Nesting depth (typical page) | 15-20 levels | ≤8 levels | Recursive depth counter |
| Memory overhead | ~2MB | <2.2MB | Chrome DevTools heap snapshot |

---

## References

- **Existing Code**: `src/tools/dom/serializers/` - three-stage pipeline architecture
- **CDP Documentation**: Chrome DevTools Protocol (DOM, Accessibility domains)
- **TypeScript Handbook**: Interface definitions, type safety patterns
- **Vitest Documentation**: Test organization, mocking, benchmarking
