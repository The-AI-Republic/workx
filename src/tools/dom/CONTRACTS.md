# DOMTool-DomService Contracts

This document defines the contracts between the DOMTool wrapper and the CDP-based DomService implementation.

## Contract 1: Snapshot Retrieval

### DOMTool Responsibility
- Validate tab ID exists
- Ensure content script injection (for fallback mode)
- Handle SerializationOptions parameter
- Route to DomService when `useCDP = true`

### DomService Responsibility
- Attach to tab via Chrome Debugger Protocol
- Build complete VirtualNode tree from CDP DOM + Accessibility trees
- Return SerializedDom with only interactive/semantic nodes
- Cache snapshot until invalidated
- Return fresh snapshot if stale (> 30s)

### Interface
```typescript
// Input (from DOMTool)
interface SnapshotRequest {
  tabId: number;
  options?: SerializationOptions;
}

// Output (from DomService)
interface SerializedDom {
  url: string;
  title: string;
  timestamp: string;
  nodes: SerializedNode[];
  frames: FrameInfo[];
  totalInteractiveElements: number;
  nodeCount: number;
}
```

### Invariants
1. Snapshot must include all interactive elements (semantic + non-semantic tiers)
2. Node IDs must be stable within a snapshot
3. Snapshot must be invalidated after any action
4. VirtualNode tree depth must not exceed `config.maxTreeDepth` (default: 100)

### Error Conditions
- `NOT_ATTACHED`: DomService not attached to tab
- `SNAPSHOT_FAILED`: Could not build VirtualNode tree
- `ALREADY_ATTACHED`: DevTools open on target tab

---

## Contract 2: Click Action

### DOMTool Responsibility
- Validate nodeId is a number (CDP numeric identifier)
- Ensure tab exists
- Route to DomService when `useCDP = true`
- Handle ActionResult success/failure

### DomService Responsibility
- Validate nodeId exists in current snapshot
- Resolve nodeId → backendNodeId
- Get element bounding box via CDP DOM.getBoxModel
- Scroll element into view if needed
- Dispatch mousePressed + mouseReleased events at center coordinates
- Send visual effect to content script (ripple)
- Invalidate snapshot after action (success or failure)

### Interface
```typescript
// Input (from DOMTool)
interface ClickRequest {
  tabId: number;
  nodeId: number;  // CDP numeric nodeId (e.g., 1469, 1537)
  options?: ClickOptions;
}

// Output (from DomService)
interface ActionResult {
  success: boolean;
  duration: number;
  visualEffect?: {
    type: 'ripple' | 'cursor' | 'highlight';
    coordinates: { x: number; y: number };
  };
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  snapshotInvalidated: boolean;
}
```

### Invariants
1. Snapshot must be invalidated after click (even on error)
2. Click coordinates must be center of bounding box
3. Visual effect sent asynchronously (graceful failure if CSP blocks)
4. Action must use current snapshot (fail if no snapshot)

### Error Conditions
- `NODE_NOT_FOUND`: nodeId not in current snapshot
- `CDP_ERROR`: Chrome DevTools Protocol error (e.g., element not found, detached)

---

## Contract 3: Type Action

### DOMTool Responsibility
- Validate nodeId is a number (CDP numeric identifier)
- Validate text parameter is string
- Ensure tab exists
- Route to DomService when `useCDP = true`

### DomService Responsibility
- Validate nodeId exists in current snapshot
- Resolve nodeId → backendNodeId
- Focus element via CDP DOM.focus
- Clear existing value (Ctrl+A, Backspace)
- Insert text via CDP Input.insertText
- Press Enter if text ends with `\n`
- Invalidate snapshot after action

### Interface
```typescript
// Input (from DOMTool)
interface TypeRequest {
  tabId: number;
  nodeId: string;  // Format: /^[A-Za-z0-9]{8}$/
  text: string;
  options?: TypeOptions;
}

// Output (from DomService)
interface ActionResult {
  success: boolean;
  duration: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  snapshotInvalidated: boolean;
}
```

### Invariants
1. Snapshot must be invalidated after type action
2. Existing value must be cleared before typing
3. Text must be inserted exactly as provided (no transformation)
4. Enter key pressed only if text ends with `\n`

### Error Conditions
- `NODE_NOT_FOUND`: nodeId not in current snapshot
- `CDP_ERROR`: Chrome DevTools Protocol error

---

## Contract 4: Keypress Action

### DOMTool Responsibility
- Validate key parameter is string
- Ensure tab exists
- Convert KeyPressOptions.modifiers to string array format
- Route to DomService when `useCDP = true`

### DomService Responsibility
- Convert modifier strings to CDP modifier bits (Ctrl=2, Shift=8, Alt=1, Meta=4)
- Dispatch keyDown + keyUp events via CDP Input.dispatchKeyEvent
- Invalidate snapshot after action

### Interface
```typescript
// Input (from DOMTool)
interface KeypressRequest {
  tabId: number;
  key: string;  // Examples: 'Enter', 'Escape', 'Tab', 'ArrowDown'
  options?: {
    modifiers?: {
      ctrl?: boolean;
      shift?: boolean;
      alt?: boolean;
      meta?: boolean;
    };
  };
}

// DomService expects
interface KeypressParams {
  key: string;
  modifiers?: string[];  // ['Ctrl', 'Shift', 'Alt', 'Meta']
}

// Output (from DomService)
interface ActionResult {
  success: boolean;
  duration: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  snapshotInvalidated: boolean;
}
```

### Invariants
1. Snapshot must be invalidated after keypress
2. Both keyDown and keyUp must be dispatched
3. Modifier bits correctly computed from modifiers array

### Error Conditions
- `CDP_ERROR`: Chrome DevTools Protocol error

---

## Contract 5: Service Lifecycle

### DOMTool Responsibility
- Never directly manage DomService lifecycle
- Always access via `DomService.forTab(tabId)`
- Rely on singleton pattern for instance reuse

### DomService Responsibility
- Implement singleton pattern per tab (Map<number, DomService>)
- Auto-attach on first `forTab()` call for new tab
- Listen for CDP DOM.documentUpdated events and invalidate snapshot
- Clean up on detach() - remove from instances map
- Handle "already attached" error gracefully

### Lifecycle Events
```typescript
// Creation
static async forTab(tabId: number, config?: Partial<ServiceConfig>): Promise<DomService>

// Attachment
async attach(): Promise<void>
// Enables: DOM.enable, Accessibility.enable
// Listens: DOM.documentUpdated → invalidateSnapshot()

// Detachment
async detach(): Promise<void>
// Cleans up: debugger.detach, clear snapshot, remove from instances

// Snapshot Management
invalidateSnapshot(): void
getCurrentSnapshot(): DomSnapshot | null
```

### Invariants
1. Only one DomService per tabId (enforced by static instances Map)
2. Must call attach() before any operations
3. Snapshot auto-invalidated on DOM.documentUpdated event
4. Detach cleans up all resources

### Error Conditions
- `ALREADY_ATTACHED`: DevTools open on tab (cannot attach)
- `ATTACH_FAILED`: CDP attach failure (permission denied, etc.)
- `NOT_ATTACHED`: Operation attempted before attach()

---

## Contract 6: Node ID Mapping

### DOMTool Responsibility
- Pass nodeId as opaque 8-character string
- Never attempt to parse or construct nodeIds
- Use nodeIds only from snapshot `nodes[].id` field

### DomService Responsibility
- Generate unique nodeIds during snapshot build (`node_${counter}`)
- Maintain bidirectional maps:
  - `nodeIdMap: Map<string, number>` (nodeId → CDP backendNodeId)
  - `backendIdMap: Map<number, string>` (CDP backendNodeId → nodeId)
- Return nodeIds in `SerializedNode.id` field
- Resolve nodeIds to backendNodeIds for all actions

### Mapping Interface
```typescript
class DomSnapshot {
  getBackendId(nodeId: string): number | null;
  getNodeId(backendNodeId: number): string | null;
}
```

### Invariants
1. NodeIds must be unique within a snapshot
2. NodeIds format: `node_${incrementing counter}`
3. NodeIds must be stable within a snapshot (but NOT across snapshots)
4. BackendNodeIds are CDP's internal identifiers

### Error Conditions
- `NODE_NOT_FOUND`: nodeId not in snapshot maps (stale or invalid)

---

## Contract 7: Snapshot Staleness

### DOMTool Responsibility
- No direct staleness checking (handled by DomService)
- Always receive fresh data from `getSerializedDom()`

### DomService Responsibility
- Track snapshot timestamp
- Check staleness on `getSerializedDom()` call
- Auto-rebuild if stale (> 30s by default)
- Auto-rebuild if `currentSnapshot === null`

### Staleness Logic
```typescript
async getSerializedDom(): Promise<SerializedDom> {
  if (!this.currentSnapshot || this.currentSnapshot.isStale()) {
    await this.buildSnapshot();
  }
  return this.currentSnapshot!.serialize();
}

isStale(maxAgeMs: number = 30000): boolean {
  return Date.now() - this.timestamp.getTime() > maxAgeMs;
}
```

### Invariants
1. Staleness threshold: 30 seconds (configurable)
2. Actions always invalidate snapshot (regardless of staleness)
3. Rebuild happens lazily on next `getSerializedDom()` call

---

## Contract 8: Error Propagation

### DOMTool Responsibility
- Wrap DomService errors in DOMToolResponse format
- Map error codes via `handleError()` method
- Include error stack in details (if Error instance)
- Always return metadata (duration, toolName, tabId)

### DomService Responsibility
- Throw errors with structured message format: `CODE: message`
- Use standard error codes from contract
- Always invalidate snapshot on error (for action methods)

### Error Response Format
```typescript
interface DOMToolResponse {
  success: false;
  error: {
    code: DOMToolErrorCode;
    message: string;
    details: {
      action: string;
      tabId: number;
      stack?: string;
    };
  };
  metadata: {
    duration: number;
    toolName: 'browser_dom';
    tabId: number;
  };
}
```

### Error Codes
```typescript
enum DOMToolErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  CONTENT_SCRIPT_NOT_LOADED = 'CONTENT_SCRIPT_NOT_LOADED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ACTION_FAILED = 'ACTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
```

### Error Mapping Rules
- "not found" | "No tab with id" → `TAB_NOT_FOUND`
- "Could not establish connection" → `CONTENT_SCRIPT_NOT_LOADED`
- "Element" + "not found" → `ELEMENT_NOT_FOUND`
- "action failed" → `ACTION_FAILED`
- "timeout" | "timed out" → `TIMEOUT`
- "permission" → `PERMISSION_DENIED`
- "Invalid action" | "is required" → `VALIDATION_ERROR`
- All others → `UNKNOWN_ERROR`

---

## Contract 9: Feature Flag Behavior

### DOMTool Responsibility
- Maintain `useCDP` boolean flag (default: `true`)
- Route to DomService when flag is `true`
- Fall back to content script when flag is `false`
- Include flag value in debug logs

### Routing Logic
```typescript
private async executeSnapshot(tabId: number, options?: SerializationOptions): Promise<SerializedDom> {
  this.log('debug', 'Executing snapshot', { tabId, options, useCDP: this.useCDP });

  if (this.useCDP) {
    const domService = await DomService.forTab(tabId);
    return await domService.getSerializedDom();
  }

  // Fall back to content script implementation
  const response = await chrome.tabs.sendMessage(tabId, { ... });
  // ...
}
```

### Invariants
1. Flag check must be first step in each execute method
2. Both code paths must return same interface (SerializedDom / ActionResult)
3. Flag value logged in all debug statements

---

## Contract 10: Visual Effects

### DOMTool Responsibility
- No direct visual effect handling
- DomService handles effects internally

### DomService Responsibility
- Send visual effects via content script message (async, non-blocking)
- Graceful degradation if content script unavailable (CSP, not injected)
- Only send effects if `config.enableVisualEffects = true`

### Visual Effect Protocol
```typescript
private sendVisualEffect(type: 'ripple' | 'cursor' | 'highlight', x: number, y: number): void {
  if (!this.config.enableVisualEffects) return;

  chrome.tabs.sendMessage(this.tabId, {
    type: 'SHOW_VISUAL_EFFECT',
    effect: { type, x, y }
  }).catch(() => {
    // Content script not available - graceful degradation
  });
}
```

### Invariants
1. Visual effects never block action completion
2. Effect coordinates from bounding box center (for click)
3. Effects respect `enableVisualEffects` config flag

---

## Testing Requirements

Each contract must have corresponding tests:

1. **Contract 1**: Test snapshot serialization, caching, staleness
2. **Contract 2**: Test click action with valid/invalid nodeIds
3. **Contract 3**: Test type action with text insertion, clearing
4. **Contract 4**: Test keypress with modifiers
5. **Contract 5**: Test singleton pattern, attach/detach lifecycle
6. **Contract 6**: Test bidirectional ID mapping
7. **Contract 7**: Test staleness detection and auto-rebuild
8. **Contract 8**: Test error propagation and mapping
9. **Contract 9**: Test feature flag routing
10. **Contract 10**: Test visual effect sending (mock chrome.tabs.sendMessage)

---

## Version History

- **v1.0.0** (2025-10-28): Initial contracts for CDP refactor
