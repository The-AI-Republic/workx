# Quickstart: Visual Effect Clearing Communication Debug

**Feature**: 009-debug-visual-effect-clear
**Date**: 2025-11-12
**Branch**: `009-debug-visual-effect-clear`

## What This Feature Does

Fixes the bug preventing visual effects (overlay, water ripple animations, cursor) from clearing automatically when BrowserAgent tasks complete. Currently, messages sent from the service worker to content scripts are not being received, leaving visual effects stuck on the page. This feature adds comprehensive diagnostic logging and fixes the message delivery chain.

## Problem Statement

**Current Behavior**:
- User runs a BrowserAgent task (e.g., "click the login button")
- Visual effects show during task execution (overlay + ripple animation)
- Task completes successfully (TaskComplete event emitted)
- Visual effects REMAIN VISIBLE (stuck state)
- User must manually refresh page to clear effects

**Root Cause**:
- `chrome.runtime.onMessage` listener in VisualEffectController is registered inside Svelte `onMount()` hook
- Messages arriving before component mounts are lost
- Service worker broadcasts to ALL tabs including restricted pages (chrome://)
- No verification that messages were delivered successfully

## Quick Setup

### Prerequisites
- Chrome Extension loaded in development mode
- At least one regular web page tab open (not chrome://)
- BrowserAgent task running with visual effects enabled

### Development Environment
```bash
# 1. Ensure you're on the feature branch
git checkout 009-debug-visual-effect-clear

# 2. Install dependencies (if needed)
npm install

# 3. Build the extension
npm run build

# 4. Load unpacked extension in Chrome
# chrome://extensions → Enable Developer Mode → Load Unpacked → dist/
```

### Enable Debug Logging

All diagnostic logs are marked with `$$$` for easy filtering:

**Chrome DevTools Console Filters**:
```
# View all debug logs
[BrowserxAgent] $$$
[ServiceWorker] $$$
[VisualEffectController] $$$

# View only message delivery chain
$$$ Sending event
$$$ DIRECT listener caught EVENT
$$$ Broadcasting EVENT
$$$ Message received
```

## Testing the Bug (Before Fix)

### Reproduce the Issue

1. **Open a web page** in a new tab (e.g., https://example.com)
2. **Open Chrome DevTools Console** (F12)
3. **Filter logs**: Enter `$$$` in the console filter
4. **Trigger a task** via the sidepanel:
   - Click Browserx extension icon
   - Enter a simple command: "click the first link"
   - Submit
5. **Observe visual effects**: Overlay + ripple animation appear
6. **Wait for task completion**: See "Task complete" in sidepanel
7. **BUG**: Visual effects remain visible instead of clearing

### Examine Diagnostic Logs

**Expected Log Sequence** (if working correctly):
```
[BrowserxAgent] $$$ Sending event to service worker: TaskComplete
[ServiceWorker] $$$ DIRECT listener caught EVENT: TaskComplete
[ServiceWorker] $$$ Broadcasting EVENT to 3 tabs
[ServiceWorker] $$$ Attempting test broadcast to tab 123
[VisualEffectController] $$$ Message received: EVENT
[VisualEffectController] $$$ Task ended, calling handleAgentStop: TaskComplete
```

**Actual Log Sequence** (current buggy behavior):
```
[BrowserxAgent] $$$ Sending event to service worker: TaskComplete
[ServiceWorker] $$$ DIRECT listener caught EVENT: TaskComplete
[ServiceWorker] $$$ Broadcasting EVENT to 3 tabs
[ServiceWorker] $$$ Attempting test broadcast to tab 123
[ServiceWorker] $$$ Test broadcast failed: Could not establish connection
# ⚠️ VisualEffectController logs MISSING - message never received!
```

## Implementation Roadmap

### Phase 1: Hoist Listener Registration (CRITICAL)

**File**: `src/content/content-script.ts` (or create if doesn't exist)

**Problem**: Listener registered inside Svelte component's `onMount()` - messages arrive before listener is ready

**Solution**: Register listener at top-level content script execution
```typescript
// src/content/content-script.ts (top-level code)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[ContentScript] $$$ Message received:', message.type);

  if (message.type === 'EVENT' && message.payload?.msg) {
    const eventMsg = message.payload.msg;

    // Dispatch DOM custom event for VisualEffectController
    if (eventMsg.type === 'TaskComplete' ||
        eventMsg.type === 'TaskFailed' ||
        eventMsg.type === 'TurnAborted') {

      document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', {
        detail: { eventType: eventMsg.type }
      }));

      sendResponse({ success: true });
      return true;
    }
  }
  return false;
});

console.log('[ContentScript] $$$ Message listener registered');
```

**File**: `src/content/ui_effect/VisualEffectController.svelte`

**Change**: Listen for DOM custom events instead of chrome.runtime messages
```typescript
// Inside setupEventListeners() function
const taskLifecycleHandler = (event: Event) => {
  const customEvent = event as CustomEvent;
  const { eventType } = customEvent.detail;

  console.log('[VisualEffectController] $$$ Task lifecycle event:', eventType);

  if (eventType === 'TaskComplete' ||
      eventType === 'TaskFailed' ||
      eventType === 'TurnAborted') {
    handleAgentStop();
  }
};

document.addEventListener('browserx:task-lifecycle', taskLifecycleHandler);
```

**Result**: Listener is always registered before messages arrive, no race condition

### Phase 2: Tab Filtering (IMPORTANT)

**File**: `src/background/service-worker.ts` (lines 197-230)

**Problem**: Broadcasting to chrome:// and chrome-extension:// tabs generates errors

**Solution**: Filter tabs before sending
```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EVENT') {
    console.log('[ServiceWorker] DIRECT listener caught EVENT:', message.payload?.msg?.type);

    (async () => {
      try {
        const tabs = await chrome.tabs.query({});

        // Filter out restricted pages
        const injectableTabs = tabs.filter(tab =>
          tab.url &&
          !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://')
        );

        console.log(`[ServiceWorker] Broadcasting EVENT to ${injectableTabs.length} tabs (filtered ${tabs.length - injectableTabs.length} restricted)`);

        for (const tab of injectableTabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'EVENT',
              payload: message.payload
            }).catch((error) => {
              console.log(`[ServiceWorker] Tab ${tab.id} not ready:`, error.message);
            });
          }
        }
      } catch (error) {
        console.error('[ServiceWorker] Broadcast failed:', error);
      }
    })();

    return false;
  }

  return false;
});
```

**Result**: No more console errors for restricted pages, cleaner logs

### Phase 3: Verification (OPTIONAL)

**File**: `src/background/service-worker.ts`

**Enhancement**: Verify content scripts are ready before broadcasting

```typescript
// Add ping-pong verification
async function verifyContentScriptReady(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch (error) {
    return false;
  }
}

// Use in broadcast loop
for (const tab of injectableTabs) {
  if (tab.id && await verifyContentScriptReady(tab.id)) {
    // Send message only if content script responded to ping
  }
}
```

**Result**: Only send messages to tabs where content scripts are confirmed ready

## Verification Steps

### After Implementing Fixes

1. **Reload extension** in chrome://extensions
2. **Open test page** (https://example.com)
3. **Open DevTools Console** with filter `$$$`
4. **Run a task** via sidepanel
5. **Verify log sequence**:
   ```
   [ContentScript] $$$ Message listener registered
   [BrowserxAgent] $$$ Sending event to service worker: TaskComplete
   [ServiceWorker] $$$ DIRECT listener caught EVENT: TaskComplete
   [ServiceWorker] $$$ Broadcasting EVENT to 2 tabs (filtered 1 restricted)
   [ContentScript] $$$ Message received: EVENT
   [VisualEffectController] $$$ Task lifecycle event: TaskComplete
   ```
6. **Verify visual effects clear** within 500ms of task completion

### Success Criteria (from spec.md)

- ✅ **SC-001**: Visual effects clear automatically within 500ms of task completion in 100% of test scenarios
- ✅ **SC-002**: Diagnostic logs capture all message delivery stages, enabling root cause identification within 2 minutes
- ✅ **SC-003**: System handles at least 10 simultaneous tabs without message delivery failures
- ✅ **SC-004**: Error reporting clearly indicates failure point in 100% of delivery failures
- ✅ **SC-005**: No false positives for expected scenarios (chrome:// pages skipped)

## Troubleshooting

### Visual Effects Still Not Clearing

**Check**:
1. Is content script injected? Look for `[ContentScript] $$$ Message listener registered` log
2. Are messages being sent? Look for `[ServiceWorker] $$$ Broadcasting EVENT` log
3. Are messages being received? Look for `[ContentScript] $$$ Message received: EVENT` log
4. Is handler being called? Look for `[VisualEffectController] $$$ Task lifecycle event` log

**If listener not registered**: Content script may not be injected on this tab
- Check tab URL - is it chrome:// or chrome-extension://?
- Check manifest.json - are content scripts configured for this URL pattern?
- Try reloading the extension

**If messages not being sent**: Service worker may have restarted
- Check service worker console (chrome://extensions → Service Worker → Inspect)
- Look for initialization logs
- Try reloading the extension

**If messages received but handler not called**: Event dispatching may have failed
- Check DOM custom event name matches: `'browserx:task-lifecycle'`
- Check event detail structure: `{ eventType: 'TaskComplete' }`
- Verify VisualEffectController added event listener for this event

### Console Errors

**"Could not establish connection. Receiving end does not exist."**
- Expected if content script not yet loaded on tab
- Should be reduced after tab filtering implementation
- Can be ignored for chrome:// pages

**"Message port closed before a response was received."**
- Service worker restarted mid-message delivery
- Chrome Manifest V3 limitation - service workers have 30-second idle timeout
- Implement reconnection logic if critical (not needed for this feature)

## Next Steps

After completing this debugging feature:

1. **Monitor logs** in production for remaining edge cases
2. **Consider removing debug logs** once stable (or add debug flag)
3. **Document known limitations** (e.g., service worker restart loses in-flight messages)
4. **Implement retry logic** if message delivery needs to be guaranteed (currently fire-and-forget)

## Related Files

- **Spec**: [spec.md](./spec.md) - Feature requirements and success criteria
- **Research**: [research.md](./research.md) - Chrome extension messaging patterns and best practices
- **Data Model**: [data-model.md](./data-model.md) - Message structure definitions
- **Plan**: [plan.md](./plan.md) - Implementation plan and technical context
- **Tasks**: [tasks.md](./tasks.md) - Generated by `/speckit.tasks` (not yet created)
