# Browser-Use Serialization - Quick Reference

## File Locations
```
/home/rich/dev/study/browser-use-study/browser_use/dom/serializer/
├── serializer.py           # Main serialization engine (955 lines)
├── clickable_elements.py   # Interactive detection (200 lines)
└── paint_order.py          # Occlusion detection (198 lines)
```

## Key Concepts at a Glance

### 1. Serialization Format

**Tab-indented text with special markers:**
```
[1]<button type="submit" aria-label="Search"/>
	[2]<input type="text" placeholder="Search..."/>
	Text content here
[3]<div role="combobox" compound_components=(name=Options,role=listbox,count=5)/>
```

**Markers:**
- `[N]` = Interactive element #N
- `*[N]` = New element #N
- `|SCROLL+[N]|` = Scrollable + interactive
- `|SHADOW(open)|` = Shadow DOM
- `▼...▲` = Shadow DOM boundaries

### 2. 4-Step Serialization Pipeline

```
Simplified Tree → Paint Order → Optimize Tree → Bbox Filter → Index & Serialize
```

### 3. Three-Tier Element Classification

1. **Semantic**: Proper ARIA role, standard tags (button, input, a, etc.)
2. **Non-Semantic**: onclick, data-testid, cursor:pointer, ARIA role on div/span
3. **Structural**: No interaction (filtered out)

---

## Code Examples

### Paint Order Filtering (RectUnion)
```python
# Remove elements covered by elements with higher paint order
rect_union = RectUnionPure()

for paint_order in sorted(orders, reverse=True):
    for node in nodes_at_order:
        if rect_union.contains(node.bounds):
            node.ignored_by_paint_order = True
        else:
            rect_union.add(node.bounds)
```

### Propagating Bounds
```python
PROPAGATING_ELEMENTS = [
    {'tag': 'a', 'role': None},              # All <a> tags
    {'tag': 'button', 'role': None},         # All <button>
    {'tag': 'div', 'role': 'button'},        # <div role="button">
]

# Bounds propagate to descendants
# Children >99% contained → excluded
# Exception: form elements, other propagating elements
```

### Compound Components (Select)
```python
_compound_children = [
    {'role': 'button', 'name': 'Dropdown Toggle'},
    {
        'role': 'listbox',
        'name': 'Options',
        'count': 42,
        'first_options': ['Option1', 'Option2', 'Option3', 'Option4'],
        'format_hint': 'country/state codes'  # Auto-detected
    }
]
```

### Interactive Detection
```python
def is_interactive(node) -> bool:
    # 11 criteria checks:
    1. Element type & tag (button, input, a, etc.)
    2. AX properties (focusable, editable, checked, etc.)
    3. Event handlers (onclick, onmousedown, tabindex)
    4. ARIA roles (button, link, combobox, etc.)
    5. Search indicators (class, id, data-*)
    6. Icon elements (10-50px with attributes)
    7. Cursor: pointer style
    # + special cases for iframes, disabled elements
```

---

## Token Optimization Strategies

| Strategy | Token Savings | Implementation |
|----------|---------------|---|
| Paint Order Filtering | 10-30% | Detect overlapping elements, hide covered ones |
| Propagating Bounds | 15-25% | Remove nested clickables inside buttons |
| Attribute Deduplication | 10-20% | Remove duplicate values, cap at 100 chars |
| Compound Components | +5-10% | But worth it for LLM accuracy |
| Clickable Detection Cache | 0% | But 40-60% speed improvement |

---

## Data Structures

### SimplifiedNode
```python
@dataclass
class SimplifiedNode:
    original_node: EnhancedDOMTreeNode
    children: list[SimplifiedNode]
    interactive_index: int | None    # [1, 2, 3...] for LLM
    is_new: bool                      # Mark new elements
    ignored_by_paint_order: bool
    excluded_by_parent: bool
    is_shadow_host: bool
    is_compound_component: bool
```

### DOMSelectorMap
```python
{
    1: button_node,
    2: input_node,
    3: link_node,
    ...
}
```

### SerializedDOMState
```python
@dataclass
class SerializedDOMState:
    _root: SimplifiedNode | None
    selector_map: DOMSelectorMap
    
    def llm_representation() -> str:
        """Returns the tab-indented text for LLM"""
```

---

## Attribute Selection

**Included by Default:**
```python
DEFAULT_INCLUDE_ATTRIBUTES = [
    'title', 'type', 'checked', 'id', 'name', 'role', 'value',
    'placeholder', 'alt', 'aria-label', 'aria-expanded',
    'aria-checked', 'aria-valuemin', 'aria-valuemax',
    'pattern', 'min', 'max', 'minlength', 'maxlength', 'step',
    'data-state', 'aria-placeholder', 'required', 'disabled',
    'invalid', 'pseudo'
]
```

**Excluded:**
- `class` (too verbose)
- CSS properties (captured in snapshot)
- Style attributes (too specific)

**Deduplication:**
- If same value in multiple attributes → keep first, remove others
- If aria-label == visible text → remove aria-label
- Cap long values at 100 chars

---

## Performance Metrics

Browser-Use measures each step:
```python
timing_info = {
    'create_simplified_tree': 12.5,  # ms
    'calculate_paint_order': 8.3,
    'optimize_tree': 5.1,
    'bbox_filtering': 3.2,
    'assign_interactive_indices': 1.8,
    'clickable_detection_time': 22.0,
    'serialize_accessible_elements_total': 52.9
}
```

---

## Implementation Difficulty

| Task | Difficulty | Time | Priority |
|------|---|---|---|
| Compound Components | Medium | 2-3 days | P0 |
| Paint Order Filtering | Medium | 2-3 days | P0 |
| Propagating Bounds | High | 3-4 days | P1 |
| Attribute Deduplication | Low | 4-8 hours | P1 |
| Clickable Detection Cache | Low | 2-4 hours | P1 |

---

## Key Insights

1. **Multi-pass optimization is powerful**: Each pass removes different types of noise
2. **Exception rules are critical**: Don't over-filter (e.g., always keep form elements)
3. **Virtual components help LLM**: Shows structure of complex inputs without exploring
4. **Paint order is efficient**: One pass removes many hidden elements
5. **Propagating bounds are smart**: Prevents nested clickables from cluttering output

---

## Expected Impact (Combined)

- **Token Count**: 10-30% reduction
- **LLM Accuracy**: +5-15% (better focus)
- **Speed**: 40-60% faster (caching)
- **Token Cost**: -5-10% per page

---

## Files to Study

1. **serializer.py** (must read)
   - `serialize_accessible_elements()` - entry point
   - `_create_simplified_tree()` - filtering logic
   - `_apply_bounding_box_filtering()` - propagating bounds
   - `serialize_tree()` - text formatting

2. **clickable_elements.py** (must read)
   - `ClickableElementDetector.is_interactive()` - detection criteria

3. **paint_order.py** (optional but useful)
   - `RectUnionPure.contains()` - occlusion detection
   - `PaintOrderRemover.calculate_paint_order()` - filtering

---

## Quick Adoption Path

**Phase 1 (P0 - 5 days):**
1. Add compound component detection
2. Integrate paint order filtering

**Phase 2 (P1 - 3 days):**
3. Add propagating bounds filtering
4. Implement attribute deduplication

**Phase 3 (P2 - ongoing):**
5. Add clickable detection cache
6. Add format hints for selects
7. Add timing instrumentation

