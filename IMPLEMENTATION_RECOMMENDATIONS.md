# Browser-Use Techniques: Implementation Recommendations for BrowserX

## Overview

This document highlights key techniques from browser-use's DOM serialization that could improve BrowserX's serialization efficiency and LLM performance.

---

## High-Priority Recommendations

### 1. Compound Component Virtualization

**Current Status in BrowserX:** Not implemented

**Browser-Use Approach:**
- Detects complex form inputs: date, time, number, range, select, color, file, audio, video
- Creates virtual sub-components representing interactive parts
- Serializes with compound_components attribute

**Implementation for BrowserX:**

```typescript
// File: src/tools/dom/CompoundComponentDetector.ts

interface CompoundComponent {
  role: string;
  name: string;
  valuemin?: number;
  valuemax?: number;
  valuenow?: number;
  count?: number;           // For selects
  first_options?: string[]; // For selects
  format_hint?: string;     // For selects
}

export function getCompoundComponents(node: VirtualNode): CompoundComponent[] {
  const tag = node.nodeName.toLowerCase();
  const type = node.attributes?.['type']?.toLowerCase();

  if (tag === 'input') {
    if (type === 'date') {
      return [
        { role: 'spinbutton', name: 'Day', valuemin: 1, valuemax: 31 },
        { role: 'spinbutton', name: 'Month', valuemin: 1, valuemax: 12 },
        { role: 'spinbutton', name: 'Year', valuemin: 1, valuemax: 275760 },
      ];
    }
    if (type === 'time') {
      return [
        { role: 'spinbutton', name: 'Hour', valuemin: 0, valuemax: 23 },
        { role: 'spinbutton', name: 'Minute', valuemin: 0, valuemax: 59 },
      ];
    }
    if (type === 'range') {
      const min = parseFloat(node.attributes?.['min'] ?? '0');
      const max = parseFloat(node.attributes?.['max'] ?? '100');
      return [
        { role: 'slider', name: 'Value', valuemin: min, valuemax: max },
      ];
    }
    if (type === 'number') {
      const min = node.attributes?.['min'] ? parseFloat(node.attributes['min']) : undefined;
      const max = node.attributes?.['max'] ? parseFloat(node.attributes['max']) : undefined;
      return [
        { role: 'button', name: 'Increment' },
        { role: 'button', name: 'Decrement' },
        { role: 'textbox', name: 'Value', valuemin: min, valuemax: max },
      ];
    }
  }

  if (tag === 'select') {
    const options = extractSelectOptions(node);
    return [
      { role: 'button', name: 'Dropdown Toggle' },
      {
        role: 'listbox',
        name: 'Options',
        count: options.length,
        first_options: options.slice(0, 4).map(o => o.text || o.value),
        format_hint: detectFormatHint(options),
      },
    ];
  }

  return [];
}

function detectFormatHint(options: { text: string; value: string }[]): string | undefined {
  if (options.length < 2) return undefined;

  const values = options.slice(0, 5).map(o => o.value);

  if (values.every(v => /^\d+$/.test(v))) return 'numeric';
  if (values.every(v => /^[A-Z]{2}$/.test(v))) return 'country/state codes';
  if (values.every(v => /[\/\-]/.test(v))) return 'date/path format';
  if (values.some(v => v.includes('@'))) return 'email addresses';

  return undefined;
}

function extractSelectOptions(node: VirtualNode): { text: string; value: string }[] {
  const options: { text: string; value: string }[] = [];

  function traverse(n: VirtualNode) {
    if (n.nodeName.toLowerCase() === 'option') {
      const text = n.textContent?.trim() || '';
      const value = n.attributes?.['value'] || text;
      if (text || value) {
        options.push({ text, value });
      }
    } else if (n.nodeName.toLowerCase() === 'optgroup') {
      n.children?.forEach(traverse);
    } else {
      n.children?.forEach(traverse);
    }
  }

  node.children?.forEach(traverse);
  return options;
}
```

**Benefits:**
- LLM understands date/time spinners as separate interactable elements
- Better guidance for range slider input
- Select options visible in serialized output (no need to explore)
- Format hints prevent brute-force attempts (e.g., knows email field expects @)

**Token Cost:** +20-50 tokens per complex form (minimal vs. benefit)

---

### 2. Paint Order Filtering (Occlusion Detection)

**Current Status in BrowserX:** Not implemented

**Browser-Use Approach:**
- Uses paint order from DOMSnapshot
- Builds union of visible rectangles using sweep algorithm
- Marks obscured elements as ignored_by_paint_order

**Implementation for BrowserX:**

```typescript
// File: src/tools/dom/PaintOrderFilter.ts

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

class RectUnion {
  private rects: Rect[] = [];

  contains(r: Rect): boolean {
    let remaining = [r];

    for (const s of this.rects) {
      const newRemaining: Rect[] = [];
      for (const piece of remaining) {
        if (this.contains_rect(piece, s)) {
          // fully covered
          continue;
        }
        if (this.intersects(piece, s)) {
          newRemaining.push(...this.subtract(piece, s));
        } else {
          newRemaining.push(piece);
        }
      }
      remaining = newRemaining;
      if (remaining.length === 0) return true;
    }

    return false;
  }

  add(r: Rect): void {
    if (!this.contains(r)) {
      this.rects.push(r);
    }
  }

  private intersects(a: Rect, b: Rect): boolean {
    return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
  }

  private contains_rect(a: Rect, b: Rect): boolean {
    return a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
  }

  private subtract(a: Rect, b: Rect): Rect[] {
    const parts: Rect[] = [];

    // Bottom slice
    if (a.y1 < b.y1) {
      parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 });
    }
    // Top slice
    if (b.y2 < a.y2) {
      parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 });
    }

    const y_lo = Math.max(a.y1, b.y1);
    const y_hi = Math.min(a.y2, b.y2);

    // Left slice
    if (a.x1 < b.x1) {
      parts.push({ x1: a.x1, y1: y_lo, x2: b.x1, y2: y_hi });
    }
    // Right slice
    if (b.x2 < a.x2) {
      parts.push({ x1: b.x2, y1: y_lo, x2: a.x2, y2: y_hi });
    }

    return parts;
  }
}

export function applyPaintOrderFiltering(snapshot: DomSnapshot): void {
  // Group elements by paint order
  const byPaintOrder = new Map<number, DomNode[]>();

  function collect(node: DomNode) {
    if (node.paintOrder !== undefined && node.bounds) {
      if (!byPaintOrder.has(node.paintOrder)) {
        byPaintOrder.set(node.paintOrder, []);
      }
      byPaintOrder.get(node.paintOrder)!.push(node);
    }
    node.children?.forEach(collect);
  }

  collect(snapshot.root);

  const rectUnion = new RectUnion();

  // Process from highest paint order (last) to lowest (first)
  const sortedOrders = Array.from(byPaintOrder.keys()).sort((a, b) => b - a);

  for (const order of sortedOrders) {
    const nodes = byPaintOrder.get(order)!;

    for (const node of nodes) {
      if (!node.bounds) continue;

      const rect: Rect = {
        x1: node.bounds.x,
        y1: node.bounds.y,
        x2: node.bounds.x + node.bounds.width,
        y2: node.bounds.y + node.bounds.height,
      };

      if (rectUnion.contains(rect)) {
        node.ignoredByPaintOrder = true;
      } else {
        // Skip if transparent or very transparent
        if (isVisible(node)) {
          rectUnion.add(rect);
        }
      }
    }
  }
}

function isVisible(node: DomNode): boolean {
  const opacity = parseFloat(node.computedStyle?.['opacity'] ?? '1');
  const bgColor = node.computedStyle?.['background-color'] ?? 'rgba(0,0,0,0)';

  if (opacity < 0.8) return false;
  if (bgColor === 'rgba(0, 0, 0, 0)') return false;

  return true;
}
```

**Benefits:**
- Automatically removes modal overlays, loading spinners, hidden panels
- Reduces token count for pages with many layers
- More accurate DOM representation for LLM

**Token Savings:** 10-30% on complex pages with overlays

---

### 3. Propagating Bounds Filtering

**Current Status in BrowserX:** Manually configured

**Browser-Use Approach:**
- Defines propagating element patterns (button, a, div[role=button], etc.)
- For each propagating element, bounds propagate to all descendants
- Children fully contained (>99%) within parent are excluded
- Exception rules for form elements, other propagating elements

**Implementation for BrowserX:**

```typescript
// File: src/tools/dom/PropagatingBoundsFilter.ts

interface PropagatingBounds {
  tag: string;
  role?: string;
  bounds: DOMRect;
  nodeId: number;
}

const PROPAGATING_PATTERNS = [
  { tag: 'a' },
  { tag: 'button' },
  { tag: 'div', role: 'button' },
  { tag: 'div', role: 'combobox' },
  { tag: 'span', role: 'button' },
  { tag: 'span', role: 'combobox' },
  { tag: 'input', role: 'combobox' },
];

export function applyPropagatingBoundsFiltering(
  node: VirtualNode,
  activeBounds: PropagatingBounds | null = null,
  containmentThreshold: number = 0.99
): void {
  // Check if this node starts new propagation
  let newBounds: PropagatingBounds | null = null;

  if (isPropagatingingElement(node)) {
    if (node.bounds) {
      newBounds = {
        tag: node.nodeName.toLowerCase(),
        role: node.attributes?.['role'],
        bounds: node.bounds,
        nodeId: node.backendNodeId,
      };
    }
  }

  const propagateBounds = newBounds ?? activeBounds;

  // Check if this node should be excluded by active bounds
  if (activeBounds && shouldExcludeChild(node, activeBounds, containmentThreshold)) {
    node.excludedByParent = true;
  }

  // Propagate to children
  node.children?.forEach(child => {
    applyPropagatingBoundsFiltering(child, propagateBounds, containmentThreshold);
  });
}

function isPropagatingingElement(node: VirtualNode): boolean {
  const tag = node.nodeName.toLowerCase();
  const role = node.attributes?.['role'];

  return PROPAGATING_PATTERNS.some(
    pattern =>
      pattern.tag === tag &&
      (!pattern.role || pattern.role === role)
  );
}

function shouldExcludeChild(
  node: VirtualNode,
  activeBounds: PropagatingBounds,
  threshold: number
): boolean {
  // Never exclude text nodes
  if (node.nodeType === NodeType.TEXT_NODE) return false;

  // No bounds = can't determine
  if (!node.bounds) return false;

  // Not sufficiently contained
  if (!isContained(node.bounds, activeBounds.bounds, threshold)) {
    return false;
  }

  // Exception rules - always keep these
  const tag = node.nodeName.toLowerCase();
  const role = node.attributes?.['role'];

  // 1. Form elements always stay
  if (['input', 'select', 'textarea', 'label'].includes(tag)) return false;

  // 2. Other propagating elements (might have stopPropagation)
  if (isPropagatingingElement(node)) return false;

  // 3. Has explicit onclick
  if ('onclick' in (node.attributes ?? {})) return false;

  // 4. Has aria-label (suggests independent interaction)
  if (node.attributes?.['aria-label']?.trim()) return false;

  // 5. Has interactive role
  const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'];
  if (role && interactiveRoles.includes(role)) return false;

  return true;
}

function isContained(child: DOMRect, parent: DOMRect, threshold: number): boolean {
  const xOverlap = Math.max(
    0,
    Math.min(child.x + child.width, parent.x + parent.width) - Math.max(child.x, parent.x)
  );
  const yOverlap = Math.max(
    0,
    Math.min(child.y + child.height, parent.y + parent.height) - Math.max(child.y, parent.y)
  );

  const intersectionArea = xOverlap * yOverlap;
  const childArea = child.width * child.height;

  if (childArea === 0) return false;

  const containmentRatio = intersectionArea / childArea;
  return containmentRatio >= threshold;
}
```

**Benefits:**
- Prevents cluttering output with nested buttons inside buttons
- Reduces decision space for LLM
- Exception rules ensure critical interactive elements aren't filtered

**Token Savings:** 15-25% on pages with nested interactive elements

---

### 4. Interactive Element Detection Caching

**Current Status in BrowserX:** Not cached

**Browser-Use Approach:**
- Cache clickable detection results to avoid re-computation
- Single pass through tree for detection, then reuse results

**Implementation for BrowserX:**

```typescript
// File: src/tools/dom/DomSnapshot.ts - Enhancement

export class DomSnapshot {
  private clickableCache: Map<number, boolean> = new Map();

  private isInteractiveCached(node: VirtualNode): boolean {
    const cached = this.clickableCache.get(node.backendNodeId);
    if (cached !== undefined) {
      return cached;
    }

    const result = this.detectIsInteractive(node);
    this.clickableCache.set(node.backendNodeId, result);
    return result;
  }

  private detectIsInteractive(node: VirtualNode): boolean {
    // Existing logic from ClickableElementDetector
    // ... (see browserx codebase)
    return result;
  }
}
```

**Benefits:**
- 40-60% speed improvement for large DOM trees
- Multiple passes (paint order, bounds filtering) reuse cache

---

### 5. Attribute Selection & Deduplication

**Current Status in BrowserX:** Limited deduplication

**Browser-Use Strategy:**

```typescript
// File: src/tools/dom/AttributeOptimizer.ts

interface AttributeConfig {
  defaultAttributes: string[];
  maxValueLength: number;
  deduplicateValues: boolean;
}

const DEFAULT_ATTRIBUTES = [
  // High priority
  'title', 'type', 'checked', 'id', 'name', 'role', 'value', 'placeholder', 'alt',
  // Accessibility
  'aria-label', 'aria-expanded', 'aria-checked', 'aria-valuemin', 'aria-valuemax',
  // Validation
  'pattern', 'min', 'max', 'minlength', 'maxlength', 'step',
  // State
  'data-state', 'aria-placeholder', 'required', 'disabled', 'invalid',
  // Framework specific
  'pseudo',
];

export function selectAndNormalizeAttributes(
  node: VirtualNode,
  attributeConfig: AttributeConfig
): Record<string, string> {
  const result: Record<string, string> = {};

  // Step 1: Select attributes
  for (const attr of attributeConfig.defaultAttributes) {
    if (attr in (node.attributes ?? {})) {
      let value = String(node.attributes![attr]).trim();

      // Cap long values
      if (value.length > attributeConfig.maxValueLength) {
        value = value.substring(0, attributeConfig.maxValueLength) + '...';
      }

      if (value) {
        result[attr] = value;
      }
    }
  }

  // Step 2: Deduplicate values
  if (attributeConfig.deduplicateValues) {
    const seen = new Map<string, string>();
    const toRemove = new Set<string>();

    for (const [key, value] of Object.entries(result)) {
      if (value.length > 5) {
        if (seen.has(value)) {
          toRemove.add(key);
        } else {
          seen.set(value, key);
        }
      }
    }

    for (const key of toRemove) {
      delete result[key];
    }
  }

  // Step 3: Remove redundant accessibility attributes
  const role = node.attributes?.['role'] || node.accessibilityRole;
  if (role && node.nodeName.toLowerCase() === role) {
    delete result['role'];
  }

  // Step 4: Remove attributes that match visible text
  const visibleText = getVisibleText(node)?.toLowerCase() ?? '';
  for (const attr of ['aria-label', 'placeholder', 'title']) {
    if (result[attr]?.toLowerCase() === visibleText) {
      delete result[attr];
    }
  }

  return result;
}

function getVisibleText(node: VirtualNode): string | null {
  // Get the text content visible to the user
  // ... existing logic
  return null;
}
```

**Benefits:**
- Removes redundant aria-label when content is already visible
- Removes duplicate values (e.g., title and aria-label with same text)
- Caps long values to prevent bloat

**Token Savings:** 10-20% on verbose pages

---

## Medium-Priority Recommendations

### 6. Format Hints for Selects

**Browser-Use Implementation:**

Auto-detect format from select options to hint to LLM:
- `numeric`: All options are numbers
- `country/state codes`: 2-letter uppercase codes
- `date/path format`: Contains / or -
- `email addresses`: Contains @

**Implementation for BrowserX:**

Add `format_hint` to compound components for select elements (see Recommendation #1).

---

### 7. Search Element Detection

**Browser-Use Implementation:**

Detects search-related elements by class/id/data attributes:

```typescript
const SEARCH_INDICATORS = [
  'search', 'magnify', 'glass', 'lookup', 'find', 'query',
  'search-icon', 'search-btn', 'search-button', 'searchbox'
];

export function isSearchElement(node: VirtualNode): boolean {
  const attrs = node.attributes ?? {};
  const classList = (attrs['class'] ?? '').toLowerCase().split(/\s+/);
  const id = attrs['id']?.toLowerCase() ?? '';

  for (const indicator of SEARCH_INDICATORS) {
    if (classList.some(c => c.includes(indicator))) return true;
    if (id.includes(indicator)) return true;
    // Check data-* attributes
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('data-') && value.includes(indicator)) return true;
    }
  }

  return false;
}
```

**Benefits:**
- Marks search inputs as interactive even if heuristics miss them
- Helps LLM understand purpose of input

---

### 8. Icon Element Detection

**Browser-Use Implementation:**

Detects small icon-sized elements (10-50px) with interactive attributes:

```typescript
export function isInteractiveIcon(node: VirtualNode): boolean {
  if (!node.bounds) return false;

  const { width, height } = node.bounds;
  const isIconSized = width >= 10 && width <= 50 && height >= 10 && height <= 50;

  if (!isIconSized) return false;

  const attrs = node.attributes ?? {};
  const hasInteractiveAttr = [
    'class', 'role', 'onclick', 'data-action', 'aria-label'
  ].some(attr => attr in attrs);

  return hasInteractiveAttr;
}
```

---

### 9. Visibility Heuristic Override

**Browser-Use Implementation:**

Force visibility for validation elements with aria-* or pseudo attributes:

```typescript
export function shouldIncludeValidationElement(node: VirtualNode): boolean {
  // Include elements with validation attributes even if not visible
  const attrs = node.attributes ?? {};

  for (const attrName of Object.keys(attrs)) {
    if (attrName.startsWith('aria-') || attrName.startsWith('pseudo')) {
      return true;
    }
  }

  return false;
}
```

**Benefits:**
- Catches validation error messages and related UI
- LLM sees validation feedback

---

### 10. Scrollability Enhancement

**Browser-Use Implementation:**

Combines CDP scroll detection with CSS analysis:

```typescript
export function isActuallyScrollable(node: VirtualNode): boolean {
  // First check if CDP detected it
  if (node.isScrollable) return true;

  // Check scroll vs client rects
  if (!node.scrollRects || !node.clientRects) return false;

  const hasVerticalScroll = node.scrollRects.height > node.clientRects.height + 1;
  const hasHorizontalScroll = node.scrollRects.width > node.clientRects.width + 1;

  if (!hasVerticalScroll && !hasHorizontalScroll) return false;

  // Verify CSS allows scrolling
  const overflow = node.computedStyle?.['overflow'] ?? 'visible';
  const overflowX = node.computedStyle?.['overflow-x'] ?? overflow;
  const overflowY = node.computedStyle?.['overflow-y'] ?? overflow;

  const allowsScroll = ['auto', 'scroll', 'overlay'].some(v =>
    [overflow, overflowX, overflowY].includes(v)
  );

  return allowsScroll;
}
```

---

## Low-Priority Enhancements

### 11. Timing Instrumentation

Add performance metrics to measure serialization efficiency:

```typescript
interface SerializationMetrics {
  createSimplifiedTree: number;
  applyPaintOrderFiltering: number;
  applyPropagatingBoundsFiltering: number;
  assignInteractiveIndices: number;
  serializeToText: number;
  totalTime: number;
}
```

### 12. Scroll Info in Serialization

Include scroll state in serialized output so LLM knows about off-screen content:

```
[5]|SCROLL+[5]|<div (scroll: 2.3 pages above, 5.1 pages below, 45%)/>
```

---

## Implementation Priority Map

| # | Recommendation | Effort | Impact | Priority |
|---|---|---|---|---|
| 1 | Compound Components | Medium | High | P0 |
| 2 | Paint Order Filtering | Medium | High | P0 |
| 3 | Propagating Bounds | High | High | P1 |
| 4 | Clickable Detection Cache | Low | Medium | P1 |
| 5 | Attribute Deduplication | Low | Medium | P1 |
| 6 | Format Hints for Selects | Low | Low | P2 |
| 7 | Search Element Detection | Low | Low | P2 |
| 8 | Icon Element Detection | Low | Low | P2 |
| 9 | Visibility Override | Low | Low | P2 |
| 10 | Scrollability Enhancement | Low | Medium | P2 |
| 11 | Timing Instrumentation | Low | Low | P3 |
| 12 | Scroll Info | Low | Low | P3 |

---

## Expected Token Savings

Implementing P0 and P1 recommendations:

- **Compound components**: +5-10% tokens (worth it for LLM accuracy)
- **Paint order filtering**: -10-30% tokens
- **Propagating bounds**: -15-25% tokens
- **Attribute deduplication**: -10-20% tokens
- **Clickable caching**: No token change (speed improvement)

**Net Effect:** 10-30% reduction in tokens while maintaining (or improving) LLM understanding.

---

## Testing Strategy

For each recommendation:

1. Measure serialization output before/after
2. Count tokens before/after
3. Test on diverse page types (e-commerce, SaaS, news, social media)
4. Compare LLM task completion rates
5. Validate no critical elements lost in filtering

