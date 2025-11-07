# Data Model: Improved DOM Serialization

**Feature**: 008-improve-dom-serialization
**Date**: 2025-11-07

## Overview

This document describes the data model changes for the improved DOM serialization feature. The only schema change is the addition of the `testid` field to the SerializedNode interface (mapped from the HTML `data-testid` attribute). All other changes are algorithmic transformations that don't affect data structures.

## SerializedNode Schema Evolution

### Current Schema (v1.0)

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
  value?: string;
  bbox?: [number, number, number, number];
  inViewport?: boolean;
  states?: Record<string, boolean | string>;
  kids?: SerializedNode[];
}
```

### New Schema (v1.1)

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
  value?: string;
  testid?: string;  // NEW - from data-testid HTML attribute
  bbox?: [number, number, number, number];
  inViewport?: boolean;
  states?: Record<string, boolean | string>;
  kids?: SerializedNode[];
}
```

**Change Summary**:
- **Added**: `testid?: string` - optional field extracted from `data-testid` HTML attribute
- **Field Access**: `node.testid` (unquoted, clean TypeScript syntax)
- **HTML Output**: Mapped back to `data-testid` attribute in `serializedNodeToHtml()`
- **Backward Compatible**: Yes (optional field)
- **Breaking Change**: No

---

## Field Definitions

### Existing Fields (Unchanged)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `node_id` | number | Yes | CDP backendNodeId for element identification |
| `tag` | string | Yes | HTML tag name (lowercase, e.g., "button", "div") |
| `role` | string | No | ARIA role from accessibility tree (e.g., "button", "textbox") |
| `aria_label` | string | No | ARIA label from accessibility tree (element's accessible name) |
| `text` | string | No | Text content (for text nodes or elements with direct text) |
| `href` | string | No | Link URL (for `<a>` tags) |
| `input_type` | string | No | Input type (for `<input>` tags, e.g., "text", "checkbox") |
| `hint` | string | No | Placeholder text (for input fields) |
| `value` | string | No | Current value (for form inputs) |
| `bbox` | [number, number, number, number] | No | Bounding box as [x, y, width, height] in CSS pixels |
| `inViewport` | boolean | No | Whether element is >50% visible in viewport |
| `states` | Record<string, boolean \| string> | No | Element states (disabled, checked, required, expanded) |
| `kids` | SerializedNode[] | No | Child elements (renamed from "children" in v3 schema) |

### New Field

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `testid` | string | No | Value of `data-testid` HTML attribute (used for test automation) |

**Rationale for Field Name**:
- Unquoted field name for clean TypeScript access: `node.testid`
- Avoids awkward bracket syntax: no need for `node["data-testid"]`
- Preserves original HTML attribute name in output via `serializedNodeToHtml()` mapping
- Consistent with existing field naming pattern (href, input_type, hint)

**Extraction Logic** (buildSerializedNode):
```typescript
// In buildSerializedNode() method
const attrMap = new Map<string, string>();
if (node.attributes) {
  for (let i = 0; i < node.attributes.length; i += 2) {
    attrMap.set(node.attributes[i], node.attributes[i + 1]);
  }
}

// Extract data-testid and store as testid
if (attrMap.has('data-testid')) {
  serializedNode.testid = attrMap.get('data-testid');
}
```

**HTML Output Mapping** (serializedNodeToHtml):
```typescript
// Map testid field back to data-testid HTML attribute
if (node.testid) {
  attributes.push(`data-testid="${escapeHtml(node.testid)}"`);
}
```

---

## VirtualNode Structure (Unchanged)

The VirtualNode interface (internal CDP representation) is NOT modified. All transformations operate on VirtualNode trees and affect only the serialization output (SerializedNode).

```typescript
// VirtualNode remains unchanged - no modifications needed
export interface VirtualNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: VirtualNode[];
  tier: 'semantic' | 'non-semantic' | 'structural';
  interactionType?: 'click' | 'input' | 'select' | 'link';
  accessibility?: { ... };
  heuristics?: { ... };
  boundingBox?: { ... };
  // ... other CDP fields
}
```

---

## SerializedDom Structure (Unchanged)

The top-level SerializedDom interface remains unchanged.

```typescript
export interface SerializedDom {
  page: {
    context: {
      url: string;
      title: string;
      viewport: {
        width: number;
        height: number;
        scrollX: number;
        scrollY: number;
      };
    };
    body: SerializedNode;  // Root SerializedNode (usually <body> element)
  };
}
```

---

## Transformation Examples

### Example 1: Container Hoisting

**Before (7 nested divs)**:
```json
{
  "node_id": 2740,
  "tag": "div",
  "kids": [{
    "node_id": 2641,
    "tag": "div",
    "kids": [{
      "node_id": 2639,
      "tag": "div",
      "kids": [{
        "node_id": 2927,
        "tag": "div",
        "role": "generic",
        "kids": [{
          "node_id": 2911,
          "tag": "div",
          "role": "textbox",
          "aria_label": "Post text"
        }]
      }]
    }]
  }]
}
```

**After (hoisting meaningless containers)**:
```json
{
  "node_id": 2641,
  "tag": "div",
  "kids": [{
    "node_id": 2911,
    "tag": "div",
    "role": "textbox",
    "aria_label": "Post text"
  }]
}
```

**Transformation**: 7 levels → 2 levels (78% depth reduction)

---

### Example 2: Clickable Text Aggregation

**Before (nested spans with text nodes)**:
```json
{
  "node_id": 3976,
  "tag": "a",
  "role": "tab",
  "aria_label": "For you",
  "href": "/home",
  "kids": [
    {
      "node_id": 3972,
      "tag": "span",
      "kids": [{
        "node_id": 4264,
        "tag": "#text",
        "role": "StaticText",
        "aria_label": "For you",
        "text": "For you"
      }]
    }
  ]
}
```

**After (text aggregation)**:
```json
{
  "node_id": 3976,
  "tag": "a",
  "role": "tab",
  "aria_label": "For you",
  "href": "/home",
  "text": "For you"
}
```

**Transformation**: Nested structure → flat element with text field (50% size reduction)

---

### Example 3: Aria-Label Removal from Text Nodes

**Before (redundant aria-label)**:
```json
{
  "node_id": 2930,
  "tag": "#text",
  "role": "StaticText",
  "aria_label": "What's happening?",
  "text": "What's happening?"
}
```

**After (aria-label removed)**:
```json
{
  "node_id": 2930,
  "tag": "#text",
  "text": "What's happening?"
}
```

**Transformation**: Removes `role` and `aria_label` fields from text nodes (40% size reduction for text nodes)

---

### Example 4: Data-TestId Addition

**HTML Input**:
```html
<button data-testid="submit-button">Submit</button>
```

**Before (missing test identifier)**:
```json
{
  "node_id": 123,
  "tag": "button",
  "role": "button",
  "aria_label": "Submit",
  "text": "Submit"
}
```

**After (with testid extracted from data-testid attribute)**:
```json
{
  "node_id": 123,
  "tag": "button",
  "role": "button",
  "aria_label": "Submit",
  "text": "Submit",
  "testid": "submit-button"
}
```

**HTML Output (via serializedNodeToHtml)**:
```html
<button id="123" role="button" aria-label="Submit" data-testid="submit-button">Submit</button>
```

**Transformation**: Additive field for test automation (testid field mapped back to data-testid attribute in HTML)

---

## Validation Rules

### Type Safety (TypeScript)

All fields are type-checked at compile time:
- `node_id`: Must be number (CDP backendNodeId)
- `tag`: Must be string (HTML tag name)
- `"data-testid"`: Must be string if present

### Runtime Validation

No runtime validation required (trust CDP data + TypeScript compilation).

### Serialization Invariants

1. **Tree Structure**: Parent-child relationships preserved through `kids` array
2. **Node Identity**: Each node has unique `node_id` (CDP backendNodeId)
3. **Optional Fields**: All fields except `node_id` and `tag` are optional
4. **Text Nodes**: Text nodes have `tag: "#text"` and `text` field populated

---

## Backward Compatibility

### Schema Version

- **v1.0**: Original SerializedNode schema (before this feature)
- **v1.1**: SerializedNode schema with `data-testid` field (this feature)

### Compatibility Matrix

| Consumer | v1.0 Schema | v1.1 Schema | Breaking Change? |
|----------|-------------|-------------|------------------|
| LLM (OpenAI SDK) | ✅ Works | ✅ Works | No - ignores unknown fields |
| DOMTool (internal) | ✅ Works | ✅ Works | No - optional field |
| Test Suite | ✅ Works | ✅ Works | No - tests updated |
| JSON Parsers | ✅ Works | ✅ Works | No - valid JSON |

**Migration Required**: No - backward compatible additive change

---

## Performance Impact

### Memory Overhead

**Per-Node Overhead**:
- `data-testid` field: ~20 bytes average (when present)
- Estimated impact: <5% increase in serialized JSON size
- Only affects nodes with `data-testid` attribute (~5-10% of nodes)

**Token Count Impact**:
- Text aggregation: -50% tokens for clickable elements (major savings)
- Container hoisting: -70% tokens for nested containers (major savings)
- Aria-label removal: -40% tokens for text nodes (medium savings)
- Data-testid addition: +2% tokens overall (negligible cost)
- **Net Impact**: -30% to -40% overall token reduction

### Serialization Time

No significant impact expected:
- `data-testid` extraction: O(1) per node with attributes
- Overall complexity remains O(n) for n nodes

---

## Future Considerations

### Potential Schema Extensions

- **Accessibility States**: Expand `states` object with more ARIA states
- **Layout Hints**: Add flex/grid layout hints for positioning context
- **Interaction Metadata**: Add clickability confidence scores

### Deprecation Path

If schema changes become necessary:
1. Add versioning field to SerializedDom: `{ version: "1.1", page: {...} }`
2. Maintain dual serializers for backward compatibility
3. Phase out old schema after migration period

---

## References

- **Type Definitions**: `src/tools/dom/types.ts`
- **Serialization Logic**: `src/tools/dom/DomSnapshot.ts` (buildSerializedNode method)
- **HTML Output**: `src/tools/dom/utils.ts` (serializedNodeToHtml function)
