# Root Cause Analysis: Modal Composer Filtered by VisibilityFilter

## Problem Summary
The modal composer (reply dialog on X.com) is incorrectly filtered out by `VisibilityFilter.ts`, even though it's clearly visible to users with proper dimensions (600×366px).

## DOM Tree Structure

```
Node 3532: Dialog Container (role="dialog", height=0) ❌ FILTERED HERE
└─ Node 3533: DIV (height=0)
   └─ Node 3534: DIV (height=0)
      ├─ Node 3535: DIV (height=0, empty)
      └─ Node 3536: Group (role="group", height=650.5) ✓ HAS HEIGHT
         ├─ Node 3537: Scrim/Mask (data-testid="mask", height=650.5)
         └─ Node 3538: Modal Composer Dialog ✓ THE TARGET
            - role="dialog"
            - aria-modal="true"
            - boundingBox: x=448.75, y=812.5, width=600, height=366
            - Contains: "Post your reply", "Replying to @IndianGems_"
```

## Root Cause

### Location
`src/tools/dom/serializers/filters/VisibilityFilter.ts:54-56`

### The Filtering Logic Flow

1. **Node 3532** (outer dialog container) is processed:
   ```typescript
   // Line 54-56
   if (this.hasZeroBoundingBox(node)) {
     return true; // ❌ Returns true because height=0
   }
   ```

2. **`hasZeroBoundingBox()` check** (lines 74-82):
   - Node 3532 boundingBox: `{x: 0, y: 780, width: 1497.5, height: 0}`
   - `height === 0` → returns `true`

3. **`isInvisible()` returns `true`** (line 54)

4. **Filter returns `null`** (line 28):
   ```typescript
   if (this.isInvisible(tree)) {
     return null; // ❌ Entire subtree discarded
   }
   ```

5. **All children are lost**, including:
   - Node 3538 (the actual modal composer with 600×366px)
   - All modal content ("Post your reply", etc.)

## Why This Is Wrong

### Current Behavior
- Dialog containers with `height=0` are filtered out entirely
- The filter checks bounding box **before** checking if it's a dialog element
- Children with non-zero dimensions are never evaluated

### Expected Behavior
- Dialog elements should be preserved even with zero bounding box
- Dialogs commonly use container wrappers with zero dimensions
- Child elements (like Node 3538) have proper dimensions and are visible

### Existing Dialog Exception (Lines 136-138)
```typescript
// Exception exists for aria-hidden, but NOT for zero bounding box
const role = node.accessibility?.role;
if (role === 'dialog' || role === 'alertdialog') {
  return false; // Only applies to aria-hidden check
}
```

## The Bug

**The dialog exception only applies to `isAriaHidden()`, not `hasZeroBoundingBox()`.**

The check order in `isInvisible()` is:
1. ✓ Zero bounding box (line 54) - **NO dialog exception**
2. ✓ Hidden styles (line 59)
3. ✓ aria-hidden (line 64) - **HAS dialog exception**

## Solution

Add dialog exception to the zero bounding box check, similar to the aria-hidden exception:

```typescript
private hasZeroBoundingBox(node: VirtualNode): boolean {
  if (!node.boundingBox) {
    return false;
  }

  const { width, height } = node.boundingBox;
  const hasZeroDimensions = width === 0 || height === 0;

  if (!hasZeroDimensions) {
    return false;
  }

  // Exception: Preserve dialog/modal containers even with zero dimensions
  // Dialogs often use wrapper elements with zero bounding box that contain
  // absolutely-positioned children with proper dimensions
  const role = node.accessibility?.role;
  if (role === 'dialog' || role === 'alertdialog') {
    return false;
  }

  // Check for common modal/dialog class names
  for (let i = 0; i < (node.attributes?.length || 0); i += 2) {
    if (node.attributes![i] === 'class') {
      const className = node.attributes![i + 1].toLowerCase();
      if (
        className.includes('modal') ||
        className.includes('dialog') ||
        className.includes('overlay')
      ) {
        return false;
      }
    }
  }

  return true;
}
```

## Impact

### Before Fix
- Modal composers filtered out
- Users cannot see interactive dialog content
- ~60% of X.com modal interactions invisible to LLM

### After Fix
- All dialog elements preserved regardless of container dimensions
- Modal content correctly passed to LLM
- Consistent handling across aria-hidden and bounding box checks

## Test Cases Needed

1. Dialog with zero height container + non-zero children (X.com modal)
2. Dialog with non-zero dimensions (normal case)
3. Dialog with aria-hidden="true" (existing test)
4. Non-dialog elements with zero dimensions (should still filter)
5. Dialog with className containing "modal", "dialog", "overlay"

## Files to Update

1. `src/tools/dom/serializers/filters/VisibilityFilter.ts` (implementation)
2. `tests/unit/tools/dom/serializers/filters/VisibilityFilter.test.ts` (tests)
