# InputExecutor React Compatibility Fix

## Problem Summary

The DOM tool was unable to properly interact with React-based web applications (like X.com/Twitter). When the LLM tried to type into input fields, React's change detection didn't trigger, causing:
- Form buttons to remain disabled
- Input validation not running
- The app treating the input as if nothing changed

## Root Causes Identified

### 1. Wrong Event Type
**Before:**
```typescript
const inputEvent = new Event("input", { bubbles: true });
```

**Issue:** React can detect the difference between real user input and synthetic events. Using basic `Event` instead of `InputEvent` signals to frameworks that this is programmatic, not user input.

**After:**
```typescript
const inputEvent = new InputEvent("input", {
  bubbles: true,
  cancelable: true,
  composed: true,
  inputType: "insertText"  // Tells React this was typing
});
```

### 2. Incorrect React `_valueTracker` Handling

**Before (BROKEN):**
```typescript
// After setting value:
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value"
)?.set;

if (nativeInputValueSetter) {
  nativeInputValueSetter.call(inputElement, inputElement.value); // ❌ Same value!
}
```

**Issue:** Calling the setter with the SAME value that's already set has NO effect. React's `_valueTracker` still thinks nothing changed.

**After (FIXED):**
```typescript
// BEFORE setting value:
function resetReactValueTracker(element: Element): void {
  const tracker = (element as any)._valueTracker;
  if (tracker) {
    tracker.setValue("");  // ✅ Reset to empty FIRST
  }
}

// Then set the new value
// React sees: "" → "new text" = change detected!
```

### 3. Missing Keyboard Events

**Before:** Only dispatched `input` and `change` events

**Issue:** Real typing generates keyboard events. Some frameworks listen for these to validate input or enable features.

**After:** Added realistic keyboard event sequence for each character:
```typescript
function dispatchKeyboardEvents(element: Element, char: string): void {
  // keydown → keypress → keyup (mimics real typing)
}
```

### 4. Wrong Order of Operations

**Before:**
1. Set `.value` directly
2. Dispatch events
3. Try to fix React (too late!)

**After:**
1. Reset React `_valueTracker` (BEFORE changing value)
2. Set `.value` directly
3. Dispatch keyboard events
4. Dispatch InputEvent (not Event)
5. Dispatch change event

## Changes Made to src/content/dom/actions/InputExecutor.ts

### Added Helper Functions

1. **`resetReactValueTracker()`** - Resets React's internal value tracker BEFORE setting new value
2. **`dispatchKeyboardEvents()`** - Dispatches realistic keyboard event sequence for each character

### Updated `dispatchInputEvents()`

- Changed from `Event` to `InputEvent`
- Added `composed: true` and `inputType: "insertText"`
- Removed broken React workaround

### Updated `executeType()`

**For instant typing (speed = 0):**
```typescript
resetReactValueTracker(element);  // NEW: Reset BEFORE setting
setElementValue(element, currentValue + text);
dispatchInputEvents(element);
```

**For character-by-character typing (speed > 0):**
```typescript
for (const char of text) {
  resetReactValueTracker(element);     // NEW: Reset BEFORE each char
  setElementValue(element, currentValue + char);
  dispatchKeyboardEvents(element, char); // NEW: Realistic keyboard events
  dispatchInputEvents(element);
  await delay(opts.speed);
}
```

**For clearing (clearFirst = true):**
```typescript
resetReactValueTracker(element);  // NEW: Reset BEFORE clearing
setElementValue(element, "");
dispatchInputEvents(element);
```

## Why This Fixes X.com (Twitter)

X.com's composer uses React controlled components with:
1. **React synthetic event system** - Now properly triggered by `InputEvent`
2. **Value change detection** - Now works because `_valueTracker` is reset before value changes
3. **Input validation** - Now runs because React detects the change
4. **Button enable/disable** - Now updates because form state changes

Before: React thought value was unchanged → button stayed disabled
After: React detects value change → validation runs → button enables

## Testing

A test page has been created at `test-input-executor.html` that simulates React's behavior:
- Simulates `_valueTracker`
- Tracks `InputEvent` vs `Event`
- Shows when React WOULD detect changes

To test:
1. Open `test-input-executor.html` in a browser
2. Open console
3. Run `testNewImplementation()` - should work ✅
4. Run `testOldImplementation()` - should fail ❌

## References

- Design spec: `.ai_design/new_domtool_design_claude.md` (lines 1812-1896)
- React's value tracking: Internal `_valueTracker` object on input elements
- InputEvent API: https://developer.mozilla.org/en-US/docs/Web/API/InputEvent
- React synthetic events: https://react.dev/learn/responding-to-events
