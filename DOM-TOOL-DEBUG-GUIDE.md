# DOM Tool Debug Guide

Comprehensive console logging has been added to help debug issues with virtual DOM sync and input event handling on modern web pages.

## How to Use Debug Logs

1. **Open Developer Console** (F12 or right-click → Inspect)
2. **Filter logs by component** using the console filter:
   - `[DomSnapshot]` - Element lookup and snapshot validity
   - `[DomTool]` - Action execution and snapshot building
   - `[TreeBuilder]` - Virtual node creation and element mapping
   - `[InputExecutor]` - Event dispatching and React state
   - `[MutationTracker]` - DOM change detection

## Common Issues and Debug Steps

### Issue 1: "Element with node_id not found"

**Symptom:** Error message like `Element not found: abc123xyz`

**Debug Steps:**

1. Check the error in console:
```
[DomSnapshot] ❌ node_id "abc123xyz" not found in forwardMap
[DomSnapshot] Available node_ids: ['def456', 'ghi789', ...]
```

2. **Root Causes:**
   - **Stale snapshot:** The snapshot was built before the element appeared
   - **Element was removed:** The element was in DOM but got removed
   - **LLM using old node_id:** The LLM is referencing a node_id from a previous snapshot

3. **Look for these logs:**
```
[DomTool] Snapshot age: 5000ms
[DomSnapshot] ⚠️ Sample element "oldId123" is NOT connected
```

4. **Solution indicators:**
```
[DomTool] ⚠️ Snapshot is invalid, rebuilding...
[DomTool] ✅ Snapshot built successfully (time: 234ms, nodes: 156)
```

### Issue 2: "Input events not triggering JavaScript"

**Symptom:** Typing into input fields doesn't enable buttons or trigger validation

**Debug Steps:**

1. Look for React tracker state:
```
[InputExecutor] 🔍 React _valueTracker detected: ""
[InputExecutor] 🔧 Reset React _valueTracker: "old value" → ""
[InputExecutor] 📡 InputEvent dispatched (type: InputEvent, inputType: insertText)
```

2. **Check if React detects the change:**
```
[InputExecutor] 🔍 React _valueTracker after typing: ""
[InputExecutor] React would detect change: YES ✅
```

If it says `NO ❌`, the fix didn't work properly.

3. **Verify events are dispatched:**
```
[InputExecutor] 📡 InputEvent dispatched (prevented: false)
[InputExecutor] 📡 Change event dispatched (prevented: false)
```

If `prevented: true`, something on the page is blocking events.

4. **Check mutations after typing:**
```
[InputExecutor] Detected 3 DOM mutations
```

If 0 mutations, the page's JavaScript didn't react to the input.

### Issue 3: "Virtual DOM out of sync with real DOM"

**Symptom:** Elements change on page but actions fail

**Debug Steps:**

1. Check mutation tracking:
```
[MutationTracker] 📝 Recorded 5 mutations (total: 12)
[MutationTracker] Mutation breakdown: { childList: 3, attributes: 2 }
[MutationTracker] Structural changes: YES
```

2. Look for incremental updates:
```
[DomTool] Using incremental update mode...
[DomTool] Incremental update: 8 dirty elements (12 mutations)
```

3. **Check snapshot rebuild triggers:**
```
[DomTool] ========== BUILD SNAPSHOT ==========
[DomTool] Trigger: mutation
```

Triggers can be: `manual`, `action`, `mutation`, `navigation`

4. **Verify element mapping:**
```
[TreeBuilder] ♻️ Reused node_id "abc123" for: BUTTON btn-primary submit-btn
[TreeBuilder] ✨ New node_id "xyz789" for: DIV modal-content
```

If you see mostly "New node_id" on a rebuild, ID preservation is failing.

### Issue 4: "Snapshot keeps getting rebuilt"

**Symptom:** Excessive snapshot rebuilds slowing down actions

**Debug Steps:**

1. Look for rebuild frequency:
```
[DomTool] ========== BUILD SNAPSHOT ==========
[DomTool] Trigger: mutation
[DomTool] Current snapshot age: 234ms
```

If age is very low (<500ms), snapshots are rebuilding too frequently.

2. Check mutation spam:
```
[MutationTracker] 📝 Recorded 150 mutations (total: 300)
```

High mutation counts indicate page is very dynamic (animations, timers, etc.)

3. **Check validity failures:**
```
[DomSnapshot] Checking snapshot validity...
[DomSnapshot] ⚠️ Sample element "node123" is NOT connected: DIV
```

If elements frequently become disconnected, the page is heavily dynamic.

## Log Legend

### Status Indicators
- ✅ Success / Valid / Found
- ❌ Error / Invalid / Not Found
- ⚠️ Warning / Stale / Disconnected
- 🔍 Inspection / Check
- 🔧 Modification / Reset
- 📡 Event Dispatch
- 📝 Recording / Tracking
- ♻️ Reused / Preserved
- ✨ New / Created
- 🎯 Interactive Element
- 🗺️ Mapping

## Typical Successful Flow

### 1. Type Action on X.com Composer

```
[DomTool] ========== TYPE ACTION REQUEST ==========
[DomTool] node_id: a1b2c3d4
[DomTool] text: "this is a test tweet"

[DomTool] getSnapshot() called
[DomTool] Snapshot exists (age: 1234ms), checking validity...
[DomSnapshot] Checking snapshot validity...
[DomSnapshot] ✅ Snapshot valid: 10/10 sampled elements connected
[DomTool] ✅ Using existing valid snapshot

[DomSnapshot] Looking up element with node_id: a1b2c3d4
[DomSnapshot] Total mapped elements: 156
[DomSnapshot] ✅ Found element: DIV (no class) (no id)

[DomTool] ✅ Element found and connected

[InputExecutor] ========== START TYPE ACTION ==========
[InputExecutor] node_id: a1b2c3d4
[InputExecutor] Text to type: "this is a test tweet"
[InputExecutor] Element: DIV (no class) (no id)

[InputExecutor] ✅ Element is typeable
[InputExecutor] 🔍 React _valueTracker detected: ""
[InputExecutor] Step 1: Focusing element...
[InputExecutor] Element focused, activeElement: YES

[InputExecutor] Step 2: Initial value: ""
[InputExecutor] Step 4: Instant typing (speed: 0)...
[InputExecutor] 🔧 Reset React _valueTracker: "" → ""
[InputExecutor] 📡 Dispatching events...
[InputExecutor] 📡 InputEvent dispatched (type: InputEvent, inputType: insertText, prevented: false)
[InputExecutor] 📡 Change event dispatched (prevented: false)
[InputExecutor] Instant typing complete

[InputExecutor] Step 7: Final value: "this is a test tweet"
[InputExecutor] Value changed: YES (from "" to "this is a test tweet")
[InputExecutor] 🔍 React _valueTracker after typing: ""
[InputExecutor] React would detect change: YES ✅

[InputExecutor] Observing DOM mutations for 100ms...
[InputExecutor] Detected 3 DOM mutations

[InputExecutor] ========== TYPE ACTION SUCCESS ==========
[InputExecutor] Duration: 156ms

[DomTool] Type action result: ✅ SUCCESS
[DomTool] Triggering async snapshot rebuild...

[DomTool] ========== BUILD SNAPSHOT ==========
[DomTool] Trigger: action
[DomTool] Current snapshot age: 1390ms
[DomTool] Starting snapshot build...
[DomTool] Full tree rebuild (no mutations tracked)
[DomTool] Building virtual DOM tree...
[TreeBuilder] ♻️ Reused node_id "a1b2c3d4" for: DIV (no class) (no id)
[TreeBuilder] 🎯 Interactive element mapped: "a1b2c3d4" (DIV )
[DomTool] Virtual DOM tree built
[DomTool] ✅ Snapshot built successfully (trigger: action, time: 234ms, nodes: 156)
```

## Performance Monitoring

Watch for these performance indicators:

```
[DomTool] Tree stats: {
  totalNodes: 156,
  visibleNodes: 142,
  interactiveNodes: 23,
  captureTime: 234ms
}
```

**Healthy ranges:**
- `captureTime`: < 500ms for typical pages
- `totalNodes`: 100-500 for typical pages
- `interactiveNodes`: 10-50 for typical pages

**Warning signs:**
- `captureTime` > 2000ms: Very complex page or performance issue
- `totalNodes` > 1000: Extremely complex page
- `interactiveNodes` > 100: Many buttons/inputs (might be noisy)

## Filtering Tips

In Chrome DevTools Console:

1. **See only errors:**
   - Filter: `-[DomTool] ✅`
   - This hides success messages

2. **Track a specific action:**
   - Filter: `TYPE ACTION`
   - Shows start, execution, and result

3. **Monitor snapshot health:**
   - Filter: `[DomSnapshot]`
   - Watch validity checks and lookups

4. **Debug React issues:**
   - Filter: `React`
   - See tracker state and change detection

5. **Watch DOM changes:**
   - Filter: `[MutationTracker]`
   - See what's changing on the page

## Disabling Logs (If Needed)

If logs are too verbose, you can filter them out globally:

In Developer Console:
1. Click the filter icon
2. Add filter: `-[DomTool] -[InputExecutor] -[TreeBuilder]`

Or selectively enable only errors:
- Filter: `❌|⚠️`

## Reporting Issues

When reporting bugs, include:

1. **The full console log** from action start to failure
2. **URL of the page** where issue occurred
3. **Steps to reproduce** (what LLM command was run)
4. **Expected vs actual behavior**

Look for these key logs:
- `[DomSnapshot] ❌` - Element lookup failures
- `[InputExecutor] React would detect change: NO ❌` - React not detecting input
- `[DomTool] ⚠️ Snapshot is invalid` - Snapshot staleness issues
- `[MutationTracker] Structural changes: YES` - DOM changes that might affect sync
