# Feature Specification: Improved DOM Serialization

**Feature Branch**: `008-improve-dom-serialization`
**Created**: 2025-11-07
**Status**: Draft
**Input**: User description: "Improve the serialize() method in browserx/src/tools/dom/DomSnapshot.ts to reduce noise and optimize LLM token consumption while preserving semantic relationships"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reduce Meaningless Nested Containers (Priority: P1)

As a BrowserX AI agent, I need the serialized DOM to eliminate unnecessary nested divs so that I can understand the page structure without processing redundant container nodes.

**Why this priority**: This is the most impactful optimization - the debug output shows deeply nested div structures (7+ levels) where a single container would suffice. This directly addresses the largest source of token waste.

**Independent Test**: Can be fully tested by comparing serialized DOM before/after on pages with nested divs (e.g., X.com post composer) and verifies that meaningful containers (with semantic roles) are preserved while empty wrappers are removed.

**Acceptance Scenarios**:

1. **Given** a DOM tree with 7 nested divs containing a single textbox child, **When** serialization runs, **Then** only the outermost meaningful container div and the textbox are retained
2. **Given** a container div with role="textbox", **When** serialization runs, **Then** the div is preserved because it has a meaningful role
3. **Given** a container div with role="generic" and no interactive children, **When** serialization runs, **Then** the div is removed from the output
4. **Given** nested structural divs with multiple interactive siblings, **When** serialization runs, **Then** a single parent container is retained to maintain sibling relationships

---

### User Story 2 - Aggregate Text Content in Clickable Elements (Priority: P1)

As a BrowserX AI agent, I need clickable elements to show their complete text content without nested markup so that I can quickly understand what clicking the element will do.

**Why this priority**: Critical for interaction - the agent needs to see "text 1 text 2 text 3 text 4" instead of navigating 4 nested span elements. This is equal priority to P1 because it affects every clickable element.

**Independent Test**: Can be fully tested by examining links, buttons, and clickable divs in the serialized output and verifying all descendant text is aggregated into a single text string.

**Acceptance Scenarios**:

1. **Given** a link with 4 nested spans each containing text nodes, **When** serialization runs, **Then** the link contains a single aggregated text value "text 1 text 2 text 3 text 4"
2. **Given** a button with icon and text spans, **When** serialization runs, **Then** the button shows only the readable text content (icons excluded)
3. **Given** a clickable div with mixed text and nested formatting, **When** serialization runs, **Then** all text is aggregated and formatting tags are removed
4. **Given** a link with only an image child and aria-label, **When** serialization runs, **Then** the link retains the aria-label and has no text content

---

### User Story 3 - Remove All Aria-Labels from Text Nodes (Priority: P2)

As a BrowserX AI agent, I need text nodes to never show aria-labels so that I can avoid redundant information (text content is already visible).

**Why this priority**: This is an optimization rather than a critical feature - it reduces redundancy but doesn't block core functionality.

**Independent Test**: Can be fully tested by finding text nodes with aria-labels and verifying that ALL aria-labels are omitted regardless of content.

**Acceptance Scenarios**:

1. **Given** a text node with text "What's happening?" and aria-label "What's happening?", **When** serialization runs, **Then** the aria-label attribute is omitted
2. **Given** a text node with text "Submit" and aria-label "Submit form", **When** serialization runs, **Then** the aria-label is omitted (even though it provides additional context)
3. **Given** a button element with aria-label that matches its aggregated text, **When** serialization runs, **Then** the button's aria-label is preserved (only text nodes have aria-labels removed)

---

### User Story 4 - Simplify Aria-Label Inheritance (Priority: P2)

As a BrowserX AI agent, I need aria-labels to describe only the element itself, not its children, so that I don't see cascading duplicated labels.

**Why this priority**: Secondary optimization - improves quality but less critical than removing structural noise.

**Independent Test**: Can be fully tested by examining parent-child relationships where both have aria-labels and verifying parent labels don't include child label text.

**Acceptance Scenarios**:

1. **Given** a parent div with aria-label "Navigation menu" containing a button with aria-label "Home", **When** serialization runs, **Then** the parent aria-label remains "Navigation menu" (not "Navigation menu Home")
2. **Given** a list container with aria-label aggregated from items, **When** serialization runs, **Then** only the container's own aria-label is used

---

### User Story 5 - Eliminate Text Node Tags (Priority: P3)

As a BrowserX AI agent, I need text content to appear directly in parent elements without explicit #text tags so that the HTML representation is cleaner and more readable.

**Why this priority**: Lowest priority - primarily a formatting improvement that doesn't affect token count significantly.

**Independent Test**: Can be fully tested by verifying no `<#text>` tags appear in the serialized HTML output.

**Acceptance Scenarios**:

1. **Given** a paragraph with a text node child "Hello world", **When** serialization runs, **Then** the output shows `<p>Hello world</p>` instead of `<p><#text>Hello world</#text></p>`
2. **Given** a button with mixed text and element children, **When** serialization runs, **Then** text content appears inline without #text wrappers

---

### User Story 6 - Include data-testid in Serialized Output (Priority: P3)

As a BrowserX AI agent, I need to see data-testid attributes in the serialized DOM so that I can identify test-targeted elements for automation.

**Why this priority**: Nice-to-have feature that improves element identification but not critical for core functionality.

**Independent Test**: Can be fully tested by verifying elements with data-testid attributes preserve them in the SerializedNode output.

**Acceptance Scenarios**:

1. **Given** a button with `data-testid="submit-button"`, **When** serialization runs, **Then** the SerializedNode includes `testid: "submit-button"`
2. **Given** an element without data-testid, **When** serialization runs, **Then** no testid field appears in SerializedNode

---

### Edge Cases

- What happens when a clickable element contains only icons/images (no text)? (Preserve aria-label, aggregate alt text from images)
- How does the system handle deeply nested structures (15+ levels) without stack overflow? (Use iterative traversal with max depth limit already in place)
- What happens when all children of a container are filtered out? (Remove container unless it's a critical structural node like body/main)
- How does the system handle mixed content (text + elements) in clickable nodes? (Aggregate all text, discard non-interactive child elements)
- What happens when aria-label is the only meaningful content (empty text)? (Preserve aria-label as primary content indicator)

## Requirements *(mandatory)*

### Functional Requirements

#### FR-001: Container Hoisting
System MUST remove meaningless nested container divs and hoist their interactive children to the nearest meaningful parent container.

**Definition of Meaningless Container**:
- Tag is `div` with role="generic" OR no role attribute
- Has exactly one child (direct hoisting candidate)
- Has no semantic attributes (aria-label, aria-describedby, etc.)
- Is not a semantic container (role="form", "table", "dialog", "navigation", "main", "region", "article", "section")

**Definition of Meaningful Container**:
- Has a semantic role (not "generic")
- Has multiple interactive children that need grouping to understand relationships
- Contains semantic attributes that provide context
- Is explicitly listed as semantic (form, table, dialog, navigation, main, region, article, section)

#### FR-002: Empty Container Removal
System MUST remove containers that have no meaningful children after filtering.

**Meaningful Children Definition**:
- Interactive elements (tier="semantic" or "non-semantic")
- Elements with text content
- Elements with aria-labels providing context
- Elements with semantic roles

#### FR-003: Clickable Text Aggregation
System MUST aggregate all descendant text content into a single string for clickable elements (links, buttons, clickable divs).

**Text Aggregation Rules**:
- Traverse all descendants depth-first
- Extract text from text nodes only (skip aria-labels during aggregation)
- Join with single space separator
- Trim leading/trailing whitespace
- Exclude text from non-visible elements (display:none, visibility:hidden)

**Clickable Element Detection**:
- Elements with interactionType="click" or "link"
- Elements with role="button", "link", "tab", "menuitem"
- Elements with `<a>`, `<button>` tags

#### FR-004: Text Node Aria-Label Removal
System MUST omit ALL aria-label attributes from text nodes unconditionally.

**Removal Rules**:
- Apply to all text nodes (nodeType === NODE_TYPE_TEXT)
- Remove aria-label regardless of content
- Text content is already visible, making aria-label redundant
- Element nodes (buttons, links, etc.) retain their aria-labels

#### FR-005: Aria-Label Scope Limitation
System MUST ensure aria-label values describe only the element itself, not its children.

**Implementation**:
- Do NOT aggregate child aria-labels into parent aria-label
- Use element's own accessibility name from CDP Accessibility tree
- Preserve aria-label only from the element's direct attributes

#### FR-006: Text Node Tag Elimination
System MUST represent text content directly within parent elements without explicit `<#text>` tags in the HTML output.

**Implementation**:
- Modify `serializedNodeToHtml()` utility function
- Replace text node serialization with inline text content in parent element
- Maintain `node.text` field in SerializedNode structure for internal use

#### FR-007: Data-TestId Field Addition
System MUST include `data-testid` attribute values in the SerializedNode structure as `testid` field.

**Schema Addition**:
```typescript
interface SerializedNode {
  // ... existing fields
  testid?: string;  // New field from data-testid HTML attribute
}
```

**HTML Output Mapping**:
When converting SerializedNode to HTML via `serializedNodeToHtml()`, the `testid` field MUST be rendered as `data-testid` attribute:
```html
<!-- SerializedNode: { testid: "submit-button" } -->
<!-- HTML Output: -->
<button data-testid="submit-button">Submit</button>
```

#### FR-008: Preserve Existing Serialization Architecture
System MUST maintain the existing three-stage serialization pipeline architecture.

**Protected Components**:
- SerializationPipeline class
- VirtualNode to SerializedNode conversion flow
- Filter/Simplifier/Optimizer pattern
- Caching mechanism for serialized output
- backendNodeId mapping system

### Key Entities

- **VirtualNode**: Internal 1:1 representation of real DOM with CDP data (nodeId, backendNodeId, accessibility info, tier classification, heuristics)
- **SerializedNode**: Flattened, optimized structure for LLM consumption (node_id, tag, role, aria_label, text, kids, bbox, etc.)
- **SerializedDom**: Complete page snapshot containing context (URL, title, viewport) and body SerializedNode tree
- **SerializationPipeline**: Orchestrates three-stage transformation (Signal Filtering → Structure Simplification → Payload Optimization)
- **Tier Classification**: Categorizes nodes as semantic (proper a11y), non-semantic (heuristic interaction), or structural (containers only)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Token count for X.com homepage serialized DOM reduces by at least 30% compared to current implementation
- **SC-002**: Serialized DOM depth (max nesting level) reduces from 15+ levels to maximum 8 levels for typical web pages
- **SC-003**: 100% of clickable elements show aggregated text content without nested markup in serialized output
- **SC-004**: 100% of text node aria-labels are removed (all text nodes have no aria-label in serialized output)
- **SC-005**: Serialization performance remains within 10% of current baseline (no significant slowdown)
- **SC-006**: All 71 existing DOM tool tests continue to pass after changes
- **SC-007**: Manual inspection of 5 diverse websites (X.com, GitHub, Gmail, Wikipedia, Amazon) shows cleaner serialized output with preserved semantic relationships

### Quality Metrics

- **QM-001**: LLM can correctly identify clickable elements by reading aggregated text without traversing children
- **QM-002**: LLM can understand page structure from serialized output without being confused by nested empty divs
- **QM-003**: Visual inspection of serialized HTML shows improved readability compared to debug output
- **QM-004**: No loss of critical semantic information (roles, aria-labels, interaction types) during optimization

## Assumptions

1. **Existing Tier Classification is Accurate**: The current semantic/non-semantic/structural classification correctly identifies interactive elements
2. **CDP Accessibility Tree is Reliable**: Accessibility data from Chrome DevTools Protocol provides accurate role and name information
3. **SerializationPipeline Hooks Available**: The existing pipeline architecture provides extension points for new simplification logic
4. **Backward Compatibility Not Required**: This is an internal optimization - no external API contracts to preserve
5. **Performance Acceptable**: Aggressive optimization (tree traversal, text aggregation) won't exceed acceptable serialization time limits
6. **Test Framework Adequate**: Current test suite covers edge cases sufficiently to validate changes
7. **Single-Pass Optimization**: Container hoisting and text aggregation can be implemented in a single tree traversal pass

## Dependencies

- Existing `SerializationPipeline` class must support new simplification stages
- `VirtualNode` structure must contain complete accessibility data for aria-label filtering
- `serializedNodeToHtml()` utility must be modifiable for text node elimination and testid→data-testid mapping
- Attribute map construction in `buildSerializedNode()` must be accessible for data-testid extraction
- Tier classification system must remain stable during refactoring

## Out of Scope

- Changes to VirtualNode structure or CDP data collection (this is purely serialization optimization)
- Modifications to SerializedDom schema beyond adding `testid` field
- Performance optimizations to SerializationPipeline execution time (only functional improvements)
- Changes to DOM snapshot caching or invalidation logic
- UI changes or user-facing configuration options
- Support for custom serialization strategies or user-defined filters
