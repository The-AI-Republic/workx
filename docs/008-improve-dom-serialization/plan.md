# Implementation Plan: Improved DOM Serialization

**Branch**: `008-improve-dom-serialization` | **Date**: 2025-11-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-improve-dom-serialization/spec.md`

## Summary

This feature optimizes the DOM serialization pipeline to reduce LLM token consumption by 30%+ while preserving semantic relationships. The primary approach involves:

1. **Container Hoisting**: Removing nested meaningless divs (7+ levels → single meaningful container)
2. **Text Aggregation**: Collapsing nested text in clickable elements into single strings
3. **Aria-Label Cleanup**: Removing all aria-labels from text nodes unconditionally
4. **HTML Simplification**: Eliminating `<#text>` wrapper tags from serialized output
5. **Test ID Addition**: Including `data-testid` attributes in serialized output

All changes respect the existing three-stage SerializationPipeline architecture (Filter → Simplify → Optimize).

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target)
**Primary Dependencies**:
- Svelte 4.2.20 (UI components)
- Vite 5.4.20 (build tool)
- Vitest 3.2.4 (testing framework)
- Chrome Extension APIs (CDP, Storage, Debugger)

**Storage**: N/A (in-memory VirtualNode trees only)

**Testing**:
- Vitest for unit tests (16 existing DOM test files)
- Chrome Mock for extension API mocking
- JSDOM for DOM API simulation
- Coverage target: Maintain 92% (71/77 tests passing)

**Target Platform**: Chrome Extension (Manifest V3) running on Chrome/Edge browsers

**Project Type**: Single project (Chrome extension with TypeScript + Svelte)

**Performance Goals**:
- Serialization time: <200ms for typical web pages
- Token reduction: 30% minimum on X.com homepage
- Nesting depth: Reduce from 15+ levels to max 8 levels

**Constraints**:
- Must not modify VirtualNode structure (CDP data layer)
- Must preserve all existing test compatibility
- Must maintain existing SerializationPipeline architecture
- Serialization performance degradation: <10% overhead

**Scale/Scope**:
- Typical DOM trees: 1000-5000 nodes
- After filtering: 200-500 serialized nodes
- Target websites: Complex SPAs (X.com, Gmail, GitHub)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Constitution Status**: No project constitution file found (template only). Proceeding with industry best practices for TypeScript/Chrome Extension development:

**Assumed Principles**:
1. **Test-First Development**: All changes must include corresponding unit tests
2. **Backward Compatibility**: Existing tests must continue to pass
3. **Architecture Preservation**: Respect existing three-stage pipeline pattern
4. **Performance Constraints**: <10% serialization overhead
5. **Type Safety**: Strict TypeScript with no `any` types

**Gate Evaluation**:
- ✅ **No new external dependencies** - all changes use existing infrastructure
- ✅ **No breaking schema changes** - only additive change (`data-testid` field)
- ✅ **Respects architecture** - works within SerializationPipeline pattern
- ✅ **Test coverage maintained** - existing 16 test files provide baseline
- ✅ **Performance budgeted** - <10% overhead explicitly scoped

**Result**: ✅ PASS - No constitution violations

## Project Structure

### Documentation (this feature)

```text
specs/008-improve-dom-serialization/
├── spec.md                    # Feature specification (completed)
├── plan.md                    # This file (Phase 0-1 output)
├── research.md                # Design decisions and alternatives (Phase 0)
├── data-model.md              # SerializedNode schema changes (Phase 1)
├── quickstart.md              # Developer guide for testing changes (Phase 1)
├── contracts/                 # N/A (no external API contracts)
├── checklists/
│   └── requirements.md        # Spec validation checklist (completed)
└── tasks.md                   # Implementation tasks (Phase 2 - via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── tools/
│   └── dom/
│       ├── DomSnapshot.ts                    # Main serialization orchestrator (MODIFY)
│       ├── utils.ts                          # Utility functions (MODIFY - add testid→data-testid mapping)
│       ├── types.ts                          # Type definitions (MODIFY - add testid field)
│       └── serializers/
│           ├── SerializationPipeline.ts      # Three-stage orchestrator (KEEP)
│           ├── filters/                      # Stage 1: Signal filtering (KEEP)
│           │   ├── VisibilityFilter.ts
│           │   ├── TextNodeFilter.ts
│           │   ├── NoiseFilter.ts
│           │   └── SemanticContainerFilter.ts
│           ├── simplifiers/                  # Stage 2: Structure simplification (ADD NEW)
│           │   ├── TextCollapser.ts          # Existing
│           │   ├── LayoutSimplifier.ts       # Existing - ENHANCE for container hoisting
│           │   ├── AttributeDeduplicator.ts  # Existing
│           │   ├── PropagatingBoundsFilter.ts # Existing
│           │   ├── ClickableTextAggregator.ts # NEW - FR-003 implementation
│           │   └── AriaLabelCleaner.ts       # NEW - FR-004/FR-005 implementation
│           └── optimizers/                   # Stage 3: Payload optimization (KEEP)
│               ├── IdRemapper.ts
│               ├── AttributePruner.ts
│               ├── FieldNormalizer.ts
│               └── MetadataBucketer.ts
│
tests/
└── tools/
    └── dom/
        ├── __tests__/
        │   ├── DomSnapshot.test.ts           # Serialization tests (ADD CASES)
        │   ├── utils.test.ts                 # Utility tests (MODIFY)
        │   ├── integration.*.test.ts         # Integration tests (16 files - VERIFY)
        │   ├── ClickableTextAggregator.test.ts # NEW
        │   └── AriaLabelCleaner.test.ts      # NEW
        └── fixtures/                         # Test DOM samples (ADD X.com fixtures)
```

**Structure Decision**: Single project layout maintained. All changes confined to `src/tools/dom/` and corresponding test files. The existing three-stage SerializationPipeline architecture is preserved with new simplifiers added to Stage 2.

## Complexity Tracking

> **No violations detected** - this feature operates within established architecture

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | N/A | N/A |

---

## Phase 0: Research & Design Decisions

The following design decisions were made based on the existing codebase architecture:

### R-001: Container Hoisting Strategy

**Decision**: Implement container hoisting as enhancement to existing `LayoutSimplifier`

**Rationale**:
- `LayoutSimplifier` already handles wrapper collapsing logic
- Avoids creating new simplifier class for similar functionality
- Centralizes all layout-related simplification in one place

**Alternatives Considered**:
- Create new `ContainerHoister` simplifier → Rejected due to overlapping responsibility with LayoutSimplifier
- Implement in filter stage → Rejected because hoisting is structural transformation, not filtering

**Implementation Approach**:
- Add `shouldHoist()` method to detect meaningless containers (div with role="generic", single child, no semantic attributes)
- Add recursive hoisting logic to bypass chains of meaningless containers
- Preserve semantic containers (form, table, dialog, navigation, main, region, article, section)

---

### R-002: Clickable Text Aggregation Pattern

**Decision**: Create new `ClickableTextAggregator` simplifier in Stage 2

**Rationale**:
- Text aggregation is structural transformation (fits Stage 2: Structure Simplification)
- Requires deep tree traversal of clickable element children
- Independent concern from layout simplification

**Alternatives Considered**:
- Implement in `buildSerializedNode()` → Rejected due to mixing serialization with transformation logic
- Implement in `TextCollapser` → Rejected because TextCollapser merges sibling text nodes, not descendant aggregation

**Implementation Approach**:
- Detect clickable elements (interactionType="click"|"link", role="button"|"link"|"tab"|"menuitem", tag=a|button)
- Depth-first traversal to extract all text node values
- Join text with single space separator, trim whitespace
- Replace children array with empty array (or single text node with aggregated value)
- Skip non-visible text (display:none, visibility:hidden)

---

### R-003: Aria-Label Removal Strategy

**Decision**: Create new `AriaLabelCleaner` simplifier in Stage 2

**Rationale**:
- Aria-label cleanup is structural transformation (fits Stage 2)
- Simple conditional logic: if nodeType === TEXT_NODE, remove aria_label field
- Independent concern from other simplifiers

**Alternatives Considered**:
- Implement in `buildSerializedNode()` → Rejected to keep serialization logic pure
- Implement in `AttributeDeduplicator` → Rejected because this removes entire attribute, not deduplicates

**Implementation Approach**:
- Check `node.nodeType === NODE_TYPE_TEXT`
- If true, delete `aria_label` field from SerializedNode
- Element nodes (buttons, links) retain aria-labels unchanged
- Handle parent aria-label scope limitation (use only element's own accessibility.name from CDP)

---

### R-004: Text Node Tag Elimination

**Decision**: Modify `serializedNodeToHtml()` utility function

**Rationale**:
- This is presentation-layer concern (HTML output format)
- SerializedNode structure already has `text` field for text content
- No structural changes needed, only output formatting

**Alternatives Considered**:
- Change SerializedNode structure → Rejected to avoid breaking changes
- Create separate HTML renderer → Rejected due to YAGNI (current renderer sufficient)

**Implementation Approach**:
- In `serializedNodeToHtml()`, detect if node is text node (nodeType === TEXT_NODE)
- Instead of rendering `<#text data-node-id="...">content</#text>`, return `content` directly
- Parent element rendering embeds returned text inline: `<button>text content</button>`
- Maintain `node.text` field in SerializedNode for programmatic access

---

### R-005: Data-TestId Field Addition

**Decision**: Add `testid?: string` field to SerializedNode interface, map to `data-testid` attribute in HTML output

**Rationale**:
- Additive change only (backward compatible)
- Unquoted field name (no hyphen): `testid` for cleaner TypeScript access
- Extraction logic similar to existing attribute handling (href, input_type, hint)
- HTML output preserves original attribute name: `data-testid`

**Alternatives Considered**:
- Use quoted `"data-testid"` field name → Rejected due to awkward access syntax `node["data-testid"]`
- Normalize to `test_id` → Rejected to avoid both quoting and naming mismatch
- Store in generic `attributes` object → Rejected for type safety and direct access

**Implementation Approach**:
- Modify `SerializedNode` interface in `types.ts` to add `testid?: string`
- In `buildSerializedNode()`, extract `data-testid` from attribute map and store in `testid` field
- Add to serialized output if present: `if (attrMap.has('data-testid')) { serializedNode.testid = attrMap.get('data-testid'); }`
- Update `serializedNodeToHtml()` to map `testid` field back to `data-testid` HTML attribute:
  ```typescript
  if (node.testid) {
    attributes.push(`data-testid="${escapeHtml(node.testid)}"`);
  }
  ```

---

### R-006: Performance Optimization Strategy

**Decision**: Single-pass tree traversal for all simplifiers

**Rationale**:
- SerializationPipeline already supports multiple simplifiers
- Each simplifier operates on tree once, modifications accumulate
- Avoids N passes for N simplifiers (O(nodes) complexity maintained)

**Alternatives Considered**:
- Multi-pass approach (one pass per simplifier) → Rejected due to performance overhead
- Combine all simplifiers into one class → Rejected due to separation of concerns

**Implementation Approach**:
- Simplifiers execute sequentially in pipeline: TextCollapser → LayoutSimplifier (enhanced) → ClickableTextAggregator → AriaLabelCleaner
- Each simplifier modifies VirtualNode tree in-place
- Tree traversal happens once per simplifier (4 passes total for Stage 2)
- Filters/optimizers continue with existing pass structure

---

### R-007: Test Strategy

**Decision**: Add test cases to existing test files + create new test files for new simplifiers

**Rationale**:
- Existing 16 test files cover integration scenarios (cross-origin, shadow DOM, performance)
- New simplifiers need dedicated unit tests
- Regression testing via existing test suite

**Test Coverage Plan**:
- **DomSnapshot.test.ts**: Add test cases for end-to-end serialization with new features
- **utils.test.ts**: Add test cases for modified `serializedNodeToHtml()` function
- **ClickableTextAggregator.test.ts**: NEW - unit tests for text aggregation logic (10-15 cases)
- **AriaLabelCleaner.test.ts**: NEW - unit tests for aria-label removal logic (8-10 cases)
- **LayoutSimplifier.test.ts**: ADD - test cases for enhanced container hoisting (if file doesn't exist)
- **Integration tests**: Verify existing 71/77 tests continue passing

**Test Fixtures**:
- Add X.com DOM samples to `tests/tools/dom/fixtures/` for realistic testing
- Include nested div structures, clickable elements with nested spans, aria-label examples

---

## Phase 1: Data Model & Contracts

### Data Model Changes

See [data-model.md](./data-model.md) for complete SerializedNode schema evolution.

**Key Change**: Addition of `testid` field to SerializedNode interface (mapped from HTML `data-testid` attribute).

### API Contracts

**N/A** - This is internal refactoring of serialization logic. No external API contracts exposed.

The SerializedDom format remains stable:
```typescript
interface SerializedDom {
  page: {
    context: PageContext;
    body: SerializedNode;
  }
}
```

Internal consumers (LLM tool calls via DOMTool) continue using same interface.

### Developer Quickstart

See [quickstart.md](./quickstart.md) for setup, testing, and debugging guide.

---

## Phase 2: Implementation Tasks

Tasks are generated via `/speckit.tasks` command. See [tasks.md](./tasks.md) after running task generation.

**Expected Task Breakdown**:
1. Schema updates (types.ts)
2. Utility modifications (utils.ts, serializedNodeToHtml)
3. New simplifiers (ClickableTextAggregator, AriaLabelCleaner)
4. LayoutSimplifier enhancements (container hoisting)
5. DomSnapshot integration
6. Test file creation/updates
7. Validation against success criteria

---

## Success Criteria Tracking

| ID | Criterion | Target | Verification Method |
|----|-----------|--------|---------------------|
| SC-001 | Token count reduction | 30% | Compare before/after JSON size on X.com |
| SC-002 | Nesting depth reduction | Max 8 levels | Measure tree depth in serialized output |
| SC-003 | Clickable text aggregation | 100% | Scan for nested spans in clickable elements |
| SC-004 | Text node aria-label removal | 100% | Grep for aria_label in text nodes |
| SC-005 | Performance overhead | <10% | Benchmark serialization time |
| SC-006 | Test pass rate | 100% (71/77) | Run `npm test` |
| SC-007 | Manual quality check | Pass | Review 5 sites (X.com, GitHub, Gmail, Wikipedia, Amazon) |

---

## Risk Mitigation

**Risk 1**: Over-aggressive container hoisting loses semantic grouping
- **Mitigation**: Preserve containers with semantic roles (form, navigation, main, etc.)
- **Validation**: Manual review of serialized X.com timeline structure

**Risk 2**: Text aggregation breaks image-only clickable elements
- **Mitigation**: Preserve aria-label when aggregated text is empty
- **Validation**: Test fixtures for icon-only buttons

**Risk 3**: Performance degradation exceeds 10% budget
- **Mitigation**: Single-pass simplifier execution, early exit for non-applicable nodes
- **Validation**: Benchmark on 1000-node tree before/after

**Risk 4**: Breaking existing tests
- **Mitigation**: Incremental development with continuous test runs
- **Validation**: Green CI before each commit

---

## Notes

- Feature is purely optimization - no user-facing UI changes
- All changes backward compatible (additive schema change only)
- Existing SerializationPipeline architecture preserved
- No changes to VirtualNode structure (CDP data layer untouched)
