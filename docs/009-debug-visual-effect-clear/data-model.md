# Data Model: Visual Effect Clearing Communication Debug

**Feature**: 009-debug-visual-effect-clear
**Date**: 2025-11-12

## Overview

This debugging feature does not introduce new persistent data models. It enhances the existing message passing system with better logging and lifecycle management. The data structures described here are ephemeral (in-memory only) and represent messages and diagnostic information flowing through the system.

## Entities

### TaskLifecycleEvent

**Purpose**: Event emitted when BrowserAgent task completes, fails, or is aborted

**Attributes**:
- `type`: string - One of 'TaskComplete', 'TaskFailed', 'TurnAborted'
- `data`: object - Event-specific payload (optional)
  - `model_context_window`: number (optional) - For TaskStarted events
  - `reason`: string (optional) - For TurnAborted events (e.g., 'user_interrupt', 'error')
  - `submission_id`: string (optional) - For TurnAborted events
  - `message`: string (optional) - For Error events
- `timestamp`: number - When event was created (implicit in Event wrapper)

**Source**: BrowserxAgent.ts `emitEvent()` method (lines 639-661)

**Validation Rules**:
- `type` must be one of the valid EventMsg types
- For TurnAborted, `reason` should be provided
- Event must be wrapped in Event structure with id before emission

**State Transitions**: N/A (events are immutable once emitted)

**Example**:
```typescript
{
  type: 'TaskComplete',
  data: {}
}

{
  type: 'TurnAborted',
  data: {
    reason: 'user_interrupt',
    submission_id: 'sub_123'
  }
}
```

### ExtensionMessage (EVENT wrapper)

**Purpose**: Chrome extension message envelope wrapping TaskLifecycleEvent for cross-context communication

**Attributes**:
- `type`: string - Always 'EVENT' for lifecycle events
- `payload`: Event - Contains the TaskLifecycleEvent
  - `id`: string - Unique event identifier (e.g., 'evt_42')
  - `msg`: EventMsg - The actual TaskLifecycleEvent
- `timestamp`: number (optional) - When message was sent
- `tabId`: number (optional) - Target tab (for responses)
- `source`: string (optional) - 'background' | 'content' | 'sidepanel' | 'popup'

**Source**: BrowserxAgent.ts wraps events, service-worker.ts broadcasts them

**Validation Rules**:
- `type` must be 'EVENT' for lifecycle events
- `payload` must contain valid Event structure
- `payload.msg` must contain valid TaskLifecycleEvent

**Message Flow**:
1. BrowserxAgent creates Event and calls `chrome.runtime.sendMessage({ type: 'EVENT', payload: event })`
2. Service worker receives message in direct listener (lines 197-230)
3. Service worker broadcasts to all tabs via `chrome.tabs.sendMessage(tabId, { type: 'EVENT', payload: message.payload })`
4. VisualEffectController receives message via `chrome.runtime.onMessage.addListener()`

**Example**:
```typescript
{
  type: 'EVENT',
  payload: {
    id: 'evt_42',
    msg: {
      type: 'TaskComplete',
      data: {}
    }
  },
  timestamp: 1699876543210,
  source: 'background'
}
```

### MessageDeliveryLog

**Purpose**: Diagnostic log entry tracking message delivery through the system

**Attributes**:
- `stage`: string - One of 'emission', 'receipt', 'broadcast', 'delivery', 'handler'
- `success`: boolean - Whether this stage succeeded
- `error`: string (optional) - Error message if failed
- `timestamp`: number - When log entry was created
- `tabId`: number (optional) - Relevant tab ID (for broadcast/delivery/handler stages)
- `eventType`: string (optional) - Type of event being delivered (e.g., 'TaskComplete')
- `context`: string - Log context ('[BrowserxAgent]', '[ServiceWorker]', '[VisualEffectController]')

**Source**: Console logs throughout the message chain

**Validation Rules**:
- `stage` must be one of the defined stages
- If `success` is false, `error` should be provided
- `tabId` required for stages after broadcast

**Log Format Pattern**:
```typescript
console.log(`[${context}] $$$ ${stage}: ${eventType} - ${success ? 'SUCCESS' : 'FAILED'}`, {
  tabId,
  error,
  timestamp: Date.now()
});
```

**Example**:
```typescript
// Emission stage
{
  stage: 'emission',
  success: true,
  timestamp: 1699876543210,
  eventType: 'TaskComplete',
  context: '[BrowserxAgent]'
}

// Delivery failure
{
  stage: 'delivery',
  success: false,
  error: 'Could not establish connection. Receiving end does not exist.',
  timestamp: 1699876543250,
  tabId: 123,
  eventType: 'TaskComplete',
  context: '[ServiceWorker]'
}

// Handler success
{
  stage: 'handler',
  success: true,
  timestamp: 1699876543300,
  tabId: 456,
  eventType: 'TaskComplete',
  context: '[VisualEffectController]'
}
```

## Relationships

```
BrowserxAgent
    |
    | emitEvent(EventMsg)
    |
    v
chrome.runtime.sendMessage({ type: 'EVENT', payload: Event })
    |
    |
    v
ServiceWorker (direct listener)
    |
    | chrome.tabs.query({})
    |
    v
chrome.tabs.sendMessage(tabId, { type: 'EVENT', payload })
    |
    |
    v [for each tab]
VisualEffectController (chrome.runtime.onMessage)
    |
    | taskLifecycleHandler(message)
    |
    v
handleAgentStop() → Clear visual effects
```

## Message Structure Compatibility

**Current Implementation** (VisualEffectController.svelte lines 296-323):
```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if this is an EVENT message containing task lifecycle events
  if (message.type === 'EVENT' && message.payload?.msg) {
    const eventMsg = message.payload.msg;

    // Clear visual effects when task ends
    if (eventMsg.type === 'TaskComplete' ||
        eventMsg.type === 'TaskFailed' ||
        eventMsg.type === 'TurnAborted') {
      handleAgentStop();
      sendResponse({ success: true });
      return true;
    }
  }
  return false;
});
```

**Expected Message Structure**:
```typescript
{
  type: 'EVENT',                    // ✓ Checked by: message.type === 'EVENT'
  payload: {                        // ✓ Checked by: message.payload?.msg
    id: 'evt_42',
    msg: {                          // ✓ Accessed by: message.payload.msg
      type: 'TaskComplete',         // ✓ Checked by: eventMsg.type === 'TaskComplete'
      data: {}
    }
  }
}
```

## Known Issues

1. **Listener Registration Race Condition** (VisualEffectController.svelte:332):
   - Listener registered inside `onMount()` hook
   - Messages arriving before component mount are lost
   - **Solution**: Hoist listener registration to top-level content script (research.md section 3.1)

2. **No Tab Filtering** (service-worker.ts:205):
   - Broadcasts to ALL tabs including chrome://, chrome-extension://
   - Generates console errors for restricted pages
   - **Solution**: Filter tabs by URL before sending (research.md section 2.2)

3. **No Message Acknowledgment** (service-worker.ts:210-216):
   - Fire-and-forget broadcast with `.catch()` error suppression
   - No verification that content scripts received messages
   - **Solution**: Implement ping-pong verification pattern (research.md section 1.2)

## Testing Considerations

Since this is diagnostic/debugging work with ephemeral data:

- **Manual Testing Required**: Trigger task completion and examine console logs
- **No Unit Tests**: Message passing behavior is integration-level
- **Verification Method**: Console log correlation across service worker and content script contexts
- **Success Criteria**: Visual effects clear within 500ms in 100% of test scenarios (spec.md SC-001)
