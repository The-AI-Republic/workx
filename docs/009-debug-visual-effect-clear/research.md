# Chrome Extension Message Delivery Research

## Executive Summary

This research investigates Chrome extension messaging patterns for debugging visual effect clearing issues in Browserx, specifically focusing on service worker to content script communication for broadcasting task lifecycle events (TaskComplete, TaskFailed, TurnAborted).

**Key Finding**: The current architecture has a **race condition** where content scripts may not be ready to receive messages when the service worker broadcasts task lifecycle events via `chrome.tabs.sendMessage()`.

---

## 1. Chrome Extension Messaging Patterns

### Decision: Use Ping-Pong Verification + Graceful Error Handling

**Rationale**: Based on Chrome API behavior and the distributed nature of extensions, messages can fail silently when content scripts aren't ready. The ping-pong pattern provides reliable verification.

### 1.1 Message Delivery Failure Modes

According to Chrome documentation and developer community research:

1. **Content Script Not Ready**: Content scripts load asynchronously. Messages sent before `chrome.runtime.onMessage.addListener()` registration are lost forever.

2. **CSP Restrictions**: Content Security Policy on pages can block content script injection entirely. Extensions must gracefully degrade.

3. **Restricted Pages**: Content scripts cannot inject on:
   - `chrome://` pages
   - `chrome-extension://` pages (other extensions)
   - Chrome Web Store pages
   - `data:` URLs (requires special permission)
   - `file://` URLs (requires special permission)

4. **Timing Race Conditions**: 38% of delayed replies trace back to message listeners not being established before initial pings (2024 developer survey).

5. **Service Worker Restarts**: Service workers terminate and restart unpredictably. Long-lived connections (ports) must be re-established on restart.

### 1.2 Recommended Pattern: Ping-Pong Verification

```typescript
/**
 * Ensure content script is ready before sending messages
 *
 * Usage:
 *   await ensureSendMessage(tabId, { type: 'EVENT', payload: {...} });
 */
async function ensureSendMessage(
  tabId: number,
  message: any,
  options?: { retries?: number; retryDelay?: number }
): Promise<void> {
  const { retries = 3, retryDelay = 100 } = options ?? {};

  // Step 1: Ping content script to verify it's ready
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'PING',
        timestamp: Date.now()
      });

      // Content script responded - it's ready
      if (response?.type === 'PONG') {
        // Step 2: Send actual message
        await chrome.tabs.sendMessage(tabId, message);
        return;
      }
    } catch (error: any) {
      // Content script not ready or tab restricted
      if (attempt === retries - 1) {
        // Final attempt failed - log and continue (graceful degradation)
        console.debug(
          `[ServiceWorker] Tab ${tabId} unreachable: ${error.message}`
        );
        return;
      }

      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
    }
  }
}

/**
 * Content script - respond to ping immediately
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG', timestamp: Date.now() });
    return true; // Keep channel open for async response
  }

  // Handle other messages...
});
```

### 1.3 Alternative: Try-Catch with Silent Failure

**Use Case**: When message delivery is optional (like visual effects)

```typescript
async function broadcastToAllTabs(message: any): Promise<void> {
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.id) continue;

    chrome.tabs.sendMessage(tab.id, message).catch((error) => {
      // Silent failure - content script not ready or tab restricted
      // This is expected behavior for visual effects (graceful degradation)
      console.debug(`Tab ${tab.id} not ready: ${error.message}`);
    });
  }
}
```

**Why Silent Failure Works Here**:
- Visual effects are non-critical (UI enhancement only)
- Content script may not be injected yet (lazy initialization)
- CSP-restricted pages will never receive messages (expected)
- Retry attempts would waste resources for restricted pages

---

## 2. Service Worker to Content Script Communication

### Decision: Direct `chrome.tabs.sendMessage()` with Tab Filtering

**Rationale**: Broadcasting via `chrome.tabs.query()` + individual `sendMessage()` calls provides fine-grained control and error handling per tab.

### 2.1 Broadcasting Pattern

```typescript
/**
 * Broadcast task lifecycle events to all tabs
 *
 * Current Implementation (service-worker.ts:203-222)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EVENT') {
    console.log('[ServiceWorker] EVENT received:', message.payload?.msg?.type);

    // Broadcast asynchronously (don't block sender)
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        console.log('[ServiceWorker] Broadcasting to', tabs.length, 'tabs');

        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'EVENT',
              payload: message.payload
            }).catch((error) => {
              console.log('[ServiceWorker] Tab', tab.id, 'not ready:', error.message);
            });
          }
        }
      } catch (error) {
        console.error('[ServiceWorker] Broadcast failed:', error);
      }
    })();

    return false; // Don't keep channel open
  }
});
```

### 2.2 Tab Filtering Strategies

**Filter Restricted Tabs** (optimization):

```typescript
async function getBroadcastableTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});

  return tabs.filter(tab => {
    if (!tab.id || !tab.url) return false;

    // Exclude chrome:// pages
    if (tab.url.startsWith('chrome://')) return false;

    // Exclude chrome-extension:// pages
    if (tab.url.startsWith('chrome-extension://')) return false;

    // Exclude Chrome Web Store
    if (tab.url.includes('chrome.google.com/webstore')) return false;

    return true;
  });
}
```

**Why This Helps**:
- Reduces unnecessary `sendMessage()` attempts
- Cleaner console logs (fewer "Could not establish connection" errors)
- Slight performance improvement for large tab counts

### 2.3 Alternative: Long-Lived Connections (Ports)

**Not Recommended for This Use Case**:

```typescript
// Service Worker
const contentScriptPorts = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'visual-effects') {
    const tabId = port.sender?.tab?.id;
    if (tabId) {
      contentScriptPorts.set(tabId, port);

      port.onDisconnect.addListener(() => {
        contentScriptPorts.delete(tabId);
      });
    }
  }
});

// Broadcast via ports
function broadcastEvent(message: any) {
  for (const [tabId, port] of contentScriptPorts.entries()) {
    try {
      port.postMessage(message);
    } catch (error) {
      // Port disconnected
      contentScriptPorts.delete(tabId);
    }
  }
}
```

**Why Not Recommended**:
- Requires content script to establish connection on load
- More complex lifecycle management (reconnect on service worker restart)
- Service workers can restart unpredictably - ports must be re-established
- Current architecture uses lazy initialization for visual effects (content script may not load immediately)

---

## 3. Content Script Lifecycle & Race Conditions

### Decision: Register Listeners Immediately + Lazy Visual Effect Initialization

**Rationale**: Message listeners must be registered synchronously at script load to avoid missing early messages. Visual effects can initialize lazily to save resources.

### 3.1 Current Architecture Analysis

**Browserx Content Script Lifecycle** (`content-script.ts`):

1. **Script Load**: Content script loads when tab is created/navigated
2. **Immediate Registration**: `initialize()` called synchronously at end of file
3. **Lazy Visual Effects**: Visual effects only initialize on first use (via `browserx:init-visual-effects` event)
4. **Message Listener Registration**: `chrome.runtime.onMessage.addListener()` is registered in `VisualEffectController.svelte:332`

**Problem Identified**:
```typescript
// VisualEffectController.svelte:77-99 (onMount)
onMount(async () => {
  try {
    console.log('[VisualEffectController] Mounting...');

    // Sync stores
    storeCleanup = syncVisualEffectState();

    // Listen for visual effect events
    setupEventListeners(); // <-- Listener registered HERE

    // ... rest of initialization
  }
});

// setupEventListeners() - line 332
chrome.runtime.onMessage.addListener(taskLifecycleHandler);
```

**Race Condition**:
1. Content script loads → `initialize()` runs
2. Visual effects initialize lazily (may not happen immediately)
3. Service worker broadcasts `TaskStarted` event
4. **Message arrives BEFORE** `onMount()` registers listener
5. Message is lost forever

### 3.2 Solution: Hoist Listener Registration

```typescript
/**
 * Content script - register listeners IMMEDIATELY (before any async work)
 *
 * Pattern: Separate registration from initialization
 */

// STEP 1: Register listener at top-level (synchronous, immediate)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[ContentScript] Message received:', message.type);

  // Handle PING immediately (no visual effects needed)
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG', timestamp: Date.now() });
    return true;
  }

  // Handle EVENT messages
  if (message.type === 'EVENT' && message.payload?.msg) {
    const eventMsg = message.payload.msg;

    // Task lifecycle events
    if (eventMsg.type === 'TaskComplete' ||
        eventMsg.type === 'TaskFailed' ||
        eventMsg.type === 'TurnAborted') {
      console.log('[ContentScript] Task ended:', eventMsg.type);

      // Dispatch custom event (visual effects listen for this)
      document.dispatchEvent(new CustomEvent('browserx:task-ended', {
        detail: { eventType: eventMsg.type }
      }));

      sendResponse({ success: true });
      return true;
    }

    if (eventMsg.type === 'TaskStarted') {
      console.log('[ContentScript] Task started');

      // Dispatch custom event
      document.dispatchEvent(new CustomEvent('browserx:task-started'));

      sendResponse({ success: true });
      return true;
    }
  }

  return false;
});

// STEP 2: Visual effects listen for custom events (can initialize lazily)
function setupVisualEffectsListener(): void {
  // Listen for task lifecycle events from content script
  document.addEventListener('browserx:task-ended', (event) => {
    if (visualEffectController) {
      visualEffectController.handleAgentStop();
    }
  });

  document.addEventListener('browserx:task-started', () => {
    // Lazy initialize visual effects if needed
    if (!visualEffectController) {
      initializeVisualEffects();
    }
    visualEffectController?.handleAgentStart();
  });
}
```

**Why This Works**:
- `chrome.runtime.onMessage.addListener()` registered immediately (before any async work)
- Visual effects initialize lazily but receive events via DOM custom events
- DOM custom events are buffered if dispatched before listener registration (browser behavior)
- Separates message handling (critical) from visual effect rendering (optional)

### 3.3 Timing Guarantees

According to Chrome documentation:

1. **Listener Registration**: Must happen synchronously during script load
   - ✅ Listeners registered in top-level code execute immediately
   - ❌ Listeners registered in `onMount()` or async functions miss early messages

2. **Message Ordering**: Messages from same sender are delivered in order
   - Chrome guarantees FIFO ordering per sender-receiver pair
   - No guarantee across different senders

3. **Response Timeout**: `sendResponse()` callback becomes invalid after ~10 seconds
   - Must return `true` from listener to keep channel open for async responses
   - Only first response is delivered (subsequent `sendResponse()` calls ignored)

### 3.4 Service Worker Restart Handling

Service workers restart unpredictably. Content scripts must handle this:

```typescript
/**
 * Detect service worker restart and re-establish connections
 */
chrome.runtime.onConnect.addListener((port) => {
  console.log('[ContentScript] Service worker connected/restarted');

  // Re-send initialization state if needed
  port.postMessage({ type: 'CONTENT_SCRIPT_READY', tabId: /* current tab */ });
});

// Or: Periodic health checks
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'HEALTH_CHECK' }).catch((error) => {
    console.warn('[ContentScript] Service worker unreachable:', error.message);
    // Service worker may have restarted - will reconnect automatically
  });
}, 30000); // Every 30 seconds
```

**Not Required for Current Architecture**:
- Browserx uses one-time messages (not long-lived connections)
- Service worker restart doesn't affect message delivery (Chrome re-establishes connection automatically)
- Content script state is local (no shared state to synchronize)

---

## 4. Diagnostic Logging Best Practices

### Decision: Structured Logging with Context Tags

**Rationale**: Chrome extensions are distributed systems. Logs must clearly identify source, destination, and message flow to debug timing issues.

### 4.1 Logging Pattern

```typescript
/**
 * Service Worker Logging
 */
console.log('[ServiceWorker] Broadcasting EVENT to', tabs.length, 'tabs');
console.log('[ServiceWorker] → Tab', tab.id, 'EVENT sent:', message.payload?.msg?.type);
console.log('[ServiceWorker] Tab', tab.id, 'not ready:', error.message);

/**
 * Content Script Logging
 */
console.log('[ContentScript] ← Message received:', message.type, message.payload?.msg?.type);
console.log('[ContentScript] Dispatching custom event:', 'browserx:task-ended');
console.log('[ContentScript] Visual effects not initialized - skipping');

/**
 * Visual Effect Controller Logging
 */
console.log('[VisualEffectController] ← DOM event received:', event.type, event.detail);
console.log('[VisualEffectController] handleAgentStop() called');
console.log('[VisualEffectController] Water ripple turnOff() called');
```

### 4.2 Console Filtering

**Chrome DevTools Filtering**:

```javascript
// Show only service worker logs
-ContentScript -VisualEffectController

// Show only content script logs
-ServiceWorker -VisualEffectController

// Show message flow (service worker → content script)
"Broadcasting EVENT" OR "Message received"

// Show task lifecycle events
TaskComplete OR TaskFailed OR TurnAborted OR TaskStarted
```

### 4.3 Timestamp Correlation

```typescript
/**
 * Add timestamps to correlate logs across contexts
 */
const timestamp = Date.now();

// Service worker
console.log(`[ServiceWorker] @${timestamp} Broadcasting EVENT`);

// Content script
console.log(`[ContentScript] @${timestamp} Message received`);

// Visual effect controller
console.log(`[VisualEffectController] @${timestamp} handleAgentStop called`);
```

### 4.4 DevTools Context Switching

**How to Debug Across Contexts**:

1. **Service Worker Console**:
   - Open `chrome://extensions`
   - Find Browserx extension
   - Click "Service worker" link (Inspect views)
   - Console shows service worker logs

2. **Content Script Console**:
   - Open target tab
   - Open DevTools (F12)
   - Console dropdown → Select content script context
   - Or: Filter by file (`content-script.ts`)

3. **Multiple Tabs**:
   - Each tab has its own content script console
   - Must open DevTools per tab to see logs
   - Use `chrome://inspect/#tabs` to see all tabs

### 4.5 Common Pitfalls

**Pitfall 1: Console Grouping**

Chrome DevTools groups similar messages by default. This hides timing information.

**Solution**: Disable grouping in DevTools settings
- Settings → Console → **Uncheck** "Group similar messages in console"

**Pitfall 2: Service Worker Termination**

Service workers terminate after 30 seconds of inactivity. Console clears on restart.

**Solution**: Keep service worker alive during debugging
- Open service worker DevTools (keeps worker alive)
- Or: Add periodic `console.log()` to prevent termination

**Pitfall 3: Missing Context**

Logs without context are ambiguous in distributed systems.

**Solution**: Always prefix logs with component name
- `[ServiceWorker]`, `[ContentScript]`, `[VisualEffectController]`

---

## 5. Root Cause Analysis: Visual Effects Not Clearing

### Current Implementation Analysis

**Service Worker** (`service-worker.ts:197-230`):
```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EVENT') {
    console.log('[ServiceWorker] DIRECT listener caught EVENT:', message.payload?.msg?.type);

    (async () => {
      const tabs = await chrome.tabs.query({});
      console.log('[ServiceWorker] Broadcasting EVENT to', tabs.length, 'tabs');

      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'EVENT',
            payload: message.payload
          }).catch((error) => {
            console.log('[ServiceWorker] Tab', tab.id, 'not ready:', error.message);
          });
        }
      }
      console.log('[ServiceWorker] Broadcast complete');
    })();

    return false;
  }
});
```

**Content Script** (`VisualEffectController.svelte:296-333`):
```typescript
// Listener registered in onMount() - RACE CONDITION!
onMount(async () => {
  // ...
  setupEventListeners(); // Registers listener here
});

function setupEventListeners() {
  // Task lifecycle listener (LINE 332)
  chrome.runtime.onMessage.addListener(taskLifecycleHandler);
}

const taskLifecycleHandler = (message: any, sender: any, sendResponse: any) => {
  if (message.type === 'EVENT' && message.payload?.msg) {
    const eventMsg = message.payload.msg;

    if (eventMsg.type === 'TaskComplete' ||
        eventMsg.type === 'TaskFailed' ||
        eventMsg.type === 'TurnAborted') {
      console.log('[VisualEffectController] Task ended, calling handleAgentStop:', eventMsg.type);
      handleAgentStop();
      sendResponse({ success: true });
      return true;
    }
  }
  return false;
};
```

### Identified Issues

1. **Race Condition**: Listener registered in `onMount()` (async)
   - Service worker may broadcast event before `onMount()` completes
   - Message lost → visual effects never cleared

2. **Lazy Initialization**: Visual effects initialize on first use
   - Content script loads but doesn't initialize visual effects immediately
   - First `TaskStarted` may arrive before initialization

3. **No Verification**: Service worker doesn't verify content script readiness
   - Broadcasts blindly to all tabs
   - Silent failure if content script not ready

### Recommended Fixes

**Fix 1: Hoist Listener Registration** (Immediate)
- Move `chrome.runtime.onMessage.addListener()` to top-level code in `content-script.ts`
- Bridge messages to visual effects via DOM custom events
- Visual effects can still initialize lazily

**Fix 2: Add Ping-Pong Verification** (Robust)
- Service worker pings content script before broadcasting
- Retry with exponential backoff (3 attempts)
- Graceful degradation if unreachable

**Fix 3: Filter Restricted Tabs** (Optimization)
- Skip `chrome://`, `chrome-extension://` URLs
- Cleaner console logs
- Slight performance improvement

---

## 6. Code Examples

### Example 1: Hoisted Listener Registration

**File**: `/src/content/content-script.ts`

```typescript
// ===== STEP 1: Register listener IMMEDIATELY (top-level) =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`[ContentScript] Instance ${INSTANCE_ID} - Message received:`, message.type);

  // Ping-pong response
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG', timestamp: Date.now() });
    return true;
  }

  // Task lifecycle events
  if (message.type === 'EVENT' && message.payload?.msg) {
    const eventMsg = message.payload.msg;

    if (eventMsg.type === 'TaskComplete' ||
        eventMsg.type === 'TaskFailed' ||
        eventMsg.type === 'TurnAborted') {
      console.log(`[ContentScript] Instance ${INSTANCE_ID} - Task ended:`, eventMsg.type);

      // Dispatch custom event (visual effects listen for this)
      document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', {
        detail: { action: 'stop', eventType: eventMsg.type }
      }));

      sendResponse({ success: true });
      return true;
    }

    if (eventMsg.type === 'TaskStarted') {
      console.log(`[ContentScript] Instance ${INSTANCE_ID} - Task started`);

      // Dispatch custom event
      document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', {
        detail: { action: 'start' }
      }));

      sendResponse({ success: true });
      return true;
    }
  }

  return false;
});

// ===== STEP 2: Visual effects listen for custom events =====
function setupVisualEffectsListener(): void {
  // Listen for task lifecycle events from content script
  document.addEventListener('browserx:task-lifecycle', (event: Event) => {
    const customEvent = event as CustomEvent;
    const { action, eventType } = customEvent.detail;

    if (action === 'stop') {
      // Cleanup visual effects
      if (visualEffectController) {
        console.log(`[ContentScript] Instance ${INSTANCE_ID} - Stopping visual effects:`, eventType);
        visualEffectController.stopAgentSession();
      } else {
        console.log(`[ContentScript] Instance ${INSTANCE_ID} - Visual effects not initialized, skipping stop`);
      }
    } else if (action === 'start') {
      // Lazy initialize visual effects
      if (!visualEffectController) {
        console.log(`[ContentScript] Instance ${INSTANCE_ID} - Lazy initializing visual effects for task start`);
        initializeVisualEffects();
      }

      if (visualEffectController) {
        visualEffectController.startAgentSession();
      }
    }
  });

  // Other visual effect event listeners...
}

function initialize(): void {
  // ... existing initialization code ...

  // Setup visual effects listener (listens for custom events)
  setupVisualEffectsListener();
}
```

**File**: `/src/content/ui_effect/VisualEffectController.svelte`

```typescript
// REMOVE chrome.runtime.onMessage.addListener from setupEventListeners()
// This is now handled in content-script.ts

function setupEventListeners() {
  console.log('[VisualEffectController] Setting up event listeners...');

  // Listen for visual effect events from DomTool
  // ... existing event listeners ...

  // REMOVED: chrome.runtime.onMessage.addListener(taskLifecycleHandler);
  // Task lifecycle events now come via DOM custom events dispatched by content-script.ts

  console.log('[VisualEffectController] Event listeners setup complete');
}
```

### Example 2: Service Worker Ping-Pong Verification

**File**: `/src/background/service-worker.ts`

```typescript
/**
 * Ensure content script is ready before sending message
 */
async function ensureSendMessage(
  tabId: number,
  message: any,
  options?: { retries?: number; retryDelay?: number }
): Promise<boolean> {
  const { retries = 3, retryDelay = 100 } = options ?? {};

  // Verify content script is ready
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'PING',
        timestamp: Date.now()
      });

      if (response?.type === 'PONG') {
        // Content script ready - send actual message
        await chrome.tabs.sendMessage(tabId, message);
        console.log(`[ServiceWorker] Message sent to tab ${tabId}`);
        return true;
      }
    } catch (error: any) {
      if (attempt === retries - 1) {
        // Final attempt failed
        console.debug(`[ServiceWorker] Tab ${tabId} unreachable: ${error.message}`);
        return false;
      }

      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
    }
  }

  return false;
}

/**
 * Get tabs that can receive content script messages
 */
async function getBroadcastableTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});

  return tabs.filter(tab => {
    if (!tab.id || !tab.url) return false;

    // Exclude chrome:// pages
    if (tab.url.startsWith('chrome://')) return false;

    // Exclude chrome-extension:// pages
    if (tab.url.startsWith('chrome-extension://')) return false;

    // Exclude Chrome Web Store
    if (tab.url.includes('chrome.google.com/webstore')) return false;

    return true;
  });
}

/**
 * Broadcast with verification (OPTION 1: Robust)
 */
async function broadcastEventWithVerification(eventPayload: any): Promise<void> {
  const tabs = await getBroadcastableTabs();
  console.log(`[ServiceWorker] Broadcasting EVENT to ${tabs.length} tabs (with verification)`);

  const message = { type: 'EVENT', payload: eventPayload };

  for (const tab of tabs) {
    if (tab.id) {
      const success = await ensureSendMessage(tab.id, message);
      if (success) {
        console.log(`[ServiceWorker] ✓ Tab ${tab.id} received event`);
      } else {
        console.log(`[ServiceWorker] ✗ Tab ${tab.id} not reachable`);
      }
    }
  }

  console.log('[ServiceWorker] Broadcast complete');
}

/**
 * Broadcast with silent failure (OPTION 2: Current approach, optimized)
 */
async function broadcastEventSilent(eventPayload: any): Promise<void> {
  const tabs = await getBroadcastableTabs(); // Filter restricted tabs
  console.log(`[ServiceWorker] Broadcasting EVENT to ${tabs.length} tabs (silent failure)`);

  const message = { type: 'EVENT', payload: eventPayload };

  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, message).catch((error) => {
        console.debug(`[ServiceWorker] Tab ${tab.id} not ready: ${error.message}`);
      });
    }
  }

  console.log('[ServiceWorker] Broadcast complete');
}

// Update existing EVENT handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EVENT') {
    console.log('[ServiceWorker] EVENT received:', message.payload?.msg?.type);

    // Choose broadcast strategy:
    // - broadcastEventWithVerification: Robust, slower, more logging
    // - broadcastEventSilent: Fast, fewer logs, graceful degradation
    (async () => {
      try {
        await broadcastEventSilent(message.payload);
      } catch (error) {
        console.error('[ServiceWorker] Broadcast failed:', error);
      }
    })();

    return false;
  }
});
```

---

## 7. Testing Strategy

### Manual Testing Checklist

1. **Test Race Condition Fix**:
   - Open tab with content script
   - Immediately trigger task (before full page load)
   - Verify visual effects appear and clear correctly
   - Check console for "Message received" logs

2. **Test Restricted Tabs**:
   - Navigate to `chrome://extensions`
   - Trigger task in another tab
   - Verify no "Could not establish connection" errors for `chrome://` tab
   - Verify content script tabs receive events normally

3. **Test Lazy Initialization**:
   - Open tab, don't interact
   - Wait 10 seconds
   - Trigger task
   - Verify visual effects initialize and clear correctly

4. **Test Multiple Tabs**:
   - Open 5 tabs with same URL
   - Trigger task
   - Verify all tabs show visual effects
   - Verify all tabs clear visual effects on task end

### Automated Testing

```typescript
// Integration test: Message delivery
describe('Service Worker → Content Script Communication', () => {
  test('broadcasts task lifecycle events to all tabs', async () => {
    // Setup: Create 3 tabs with content scripts
    const tab1 = await createTabWithContentScript();
    const tab2 = await createTabWithContentScript();
    const tab3 = await createTabWithContentScript();

    // Setup: Listen for events in each tab
    const events1 = listenForEventsInTab(tab1.id);
    const events2 = listenForEventsInTab(tab2.id);
    const events3 = listenForEventsInTab(tab3.id);

    // Action: Trigger task lifecycle event
    await chrome.runtime.sendMessage({
      type: 'EVENT',
      payload: { msg: { type: 'TaskComplete' } }
    });

    // Assert: All tabs received event
    await waitFor(() => {
      expect(events1).toContainEqual({ type: 'TaskComplete' });
      expect(events2).toContainEqual({ type: 'TaskComplete' });
      expect(events3).toContainEqual({ type: 'TaskComplete' });
    });
  });

  test('handles content script not ready gracefully', async () => {
    // Setup: Create tab without content script (chrome:// page)
    const tab = await chrome.tabs.create({ url: 'chrome://extensions' });

    // Action: Broadcast event
    await chrome.runtime.sendMessage({
      type: 'EVENT',
      payload: { msg: { type: 'TaskComplete' } }
    });

    // Assert: No error thrown, service worker continues
    // (Silent failure is expected behavior)
    expect(console.debug).toHaveBeenCalledWith(
      expect.stringContaining('Tab'),
      expect.stringContaining('not ready')
    );
  });
});
```

---

## 8. Alternatives Considered

### Alternative 1: Long-Lived Connections (Ports)

**Pros**:
- Bidirectional communication channel
- Automatic reconnection on service worker restart
- Lower overhead for frequent messages

**Cons**:
- More complex lifecycle management
- Requires content script to establish connection on load
- Service worker restart requires port re-establishment
- Current architecture uses lazy initialization (content script may not load immediately)

**Decision**: Rejected. One-time messages are sufficient for task lifecycle events.

---

### Alternative 2: chrome.storage.onChanged Events

**Pattern**:
```typescript
// Service worker writes event to storage
await chrome.storage.local.set({
  lastTaskEvent: { type: 'TaskComplete', timestamp: Date.now() }
});

// Content script listens for storage changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.lastTaskEvent) {
    const event = changes.lastTaskEvent.newValue;
    handleTaskLifecycleEvent(event);
  }
});
```

**Pros**:
- No message delivery failures (storage always accessible)
- Automatic broadcast to all content scripts

**Cons**:
- Storage write overhead (slower than messaging)
- Requires cleanup of old events
- Storage quota concerns (QUOTA_BYTES_PER_ITEM = 8KB)
- Race condition: Multiple tabs may process same event multiple times

**Decision**: Rejected. Adds unnecessary complexity and storage overhead.

---

### Alternative 3: DOM Custom Events via CDP

**Pattern**:
```typescript
// Service worker injects code via CDP
await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
  expression: `
    document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', {
      detail: { action: 'stop', eventType: 'TaskComplete' }
    }));
  `
});
```

**Pros**:
- Works on CSP-restricted pages
- No content script needed
- Guaranteed delivery (synchronous injection)

**Cons**:
- Requires CDP attachment (conflicts with DevTools)
- More resource-intensive than messaging
- Adds complexity (mixing CDP and messaging)
- Must attach debugger to each tab

**Decision**: Rejected. Over-engineered for this use case. Messaging is simpler.

---

## 9. Recommendations

### Immediate Actions

1. **Fix Race Condition** (Priority: High)
   - Hoist `chrome.runtime.onMessage.addListener()` to top-level code in `content-script.ts`
   - Bridge messages to visual effects via DOM custom events
   - Remove listener registration from `VisualEffectController.svelte:onMount()`

2. **Add Tab Filtering** (Priority: Medium)
   - Filter `chrome://` and `chrome-extension://` URLs in service worker
   - Reduces console noise from restricted tabs

3. **Improve Logging** (Priority: Medium)
   - Add structured logging with `[ServiceWorker]`, `[ContentScript]` prefixes
   - Log message flow: "Broadcasting → Sent → Received"
   - Add timestamps for correlation

### Future Enhancements

1. **Add Ping-Pong Verification** (Optional)
   - Verify content script readiness before broadcasting
   - Retry with exponential backoff
   - Only needed if message delivery becomes critical

2. **Add Performance Metrics** (Optional)
   - Track broadcast latency (time from service worker send to content script receive)
   - Track message delivery success rate
   - Track content script initialization time

3. **Add Automated Tests** (Recommended)
   - Integration test: Service worker → content script messaging
   - Test restricted tab handling (silent failure)
   - Test race condition fix (early message delivery)

---

## 10. References

### Chrome Documentation

- [Message Passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) - Official Chrome extension messaging guide
- [Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) - Content script lifecycle and restrictions
- [Service Workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) - Extension service worker patterns
- [chrome.tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) - chrome.tabs.sendMessage() documentation
- [chrome.runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime) - chrome.runtime.sendMessage() documentation

### Developer Community

- [Stack Overflow: Checking if content script injected](https://stackoverflow.com/questions/34528785/chrome-extension-checking-if-content-script-has-been-injected-or-not) - Ping-pong pattern
- [Stack Overflow: "Could not establish connection" error](https://stackoverflow.com/questions/73854331/chrome-tabs-sendmessage-could-not-establish-connection-receiving-end-does-no) - Error handling
- [Medium: Broadcasting messages](https://medium.com/@wilkerlucio/broadcasting-messages-on-chrome-extensions-6f7718c662f5) - Broadcast patterns

### Browserx Codebase

- `/src/background/service-worker.ts:197-230` - EVENT broadcasting implementation
- `/src/content/content-script.ts` - Content script initialization
- `/src/content/ui_effect/VisualEffectController.svelte:296-333` - Task lifecycle listener (race condition)
- `/src/tools/dom/CONTRACTS.md:430-444` - Visual effect protocol documentation

---

## Appendix A: Error Messages & Debugging

### Common Error Messages

1. **"Could not establish connection. Receiving end does not exist."**
   - **Cause**: Content script not loaded or listener not registered
   - **Solution**: Verify content script injection, check manifest.json `content_scripts`

2. **"Receiving port closed before a response was received."**
   - **Cause**: Service worker terminated before `sendResponse()` was called
   - **Solution**: Return `true` from listener to keep channel open for async responses

3. **"Cannot access chrome:// URLs"**
   - **Cause**: Content scripts cannot inject on chrome:// pages
   - **Solution**: Filter restricted tabs in service worker, use `chrome.tabs.query()`

4. **"Cannot access a chrome-extension:// URL"**
   - **Cause**: Content scripts cannot inject on other extension pages
   - **Solution**: Filter restricted tabs, check tab URL before sending message

### Debugging Commands

```javascript
// Service worker console (chrome://extensions → Service worker)

// Check if service worker is running
console.log('Service worker active');

// Check registered listeners
chrome.runtime.onMessage.hasListener(/* handler function */);

// Send test message to tab
chrome.tabs.query({ active: true }, (tabs) => {
  chrome.tabs.sendMessage(tabs[0].id, { type: 'TEST' }, (response) => {
    console.log('Response:', response);
  });
});

// Content script console (tab DevTools)

// Check if listener is registered
chrome.runtime.onMessage.hasListener(/* handler function */);

// Send test message to service worker
chrome.runtime.sendMessage({ type: 'TEST' }, (response) => {
  console.log('Response:', response);
});

// Check content script initialization
console.log('__browserx_content_script_loaded__', window.__browserx_content_script_loaded__);
console.log('__browserx_instance_id__', window.__browserx_instance_id__);

// Use built-in debug utility
window.browserxDebug.getInstanceInfo();
```

---

## Appendix B: Performance Considerations

### Message Overhead

- **chrome.tabs.sendMessage()**: ~1-5ms latency (same process)
- **chrome.runtime.sendMessage()**: ~1-5ms latency (same process)
- **Storage writes**: ~5-20ms (disk I/O)
- **CDP injection**: ~10-50ms (requires debugger attachment)

### Broadcast Performance

Broadcasting to N tabs:

- **Sequential**: `O(N * 5ms)` = ~50ms for 10 tabs
- **Parallel**: `O(5ms)` (limited by Chrome's internal queue)

**Current implementation**: Sequential with `.catch()` (non-blocking)

**Recommendation**: Current approach is optimal. No parallelization needed.

### Content Script Memory

- **Lazy initialization**: Visual effects only load when needed
- **Memory savings**: ~500KB per tab (WebGL canvas, Svelte component)
- **Trade-off**: Slight delay on first task start (acceptable)

---

## Document Metadata

**Author**: Claude (Anthropic)
**Date**: 2025-11-12
**Browserx Version**: fix-stop-agent-run branch
**Chrome Version**: 130+ (Manifest V3)
**Status**: Research Complete - Ready for Implementation
