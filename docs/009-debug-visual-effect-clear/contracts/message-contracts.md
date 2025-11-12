# Message Contracts: Visual Effect Clearing Communication

**Feature**: 009-debug-visual-effect-clear
**Date**: 2025-11-12

## Overview

This document defines the message contracts for Chrome extension communication between the service worker background script and content scripts. These contracts ensure consistent message structure throughout the delivery chain.

## Contract Definitions

### 1. EVENT Message (Service Worker → Content Script)

**Purpose**: Notify content scripts of task lifecycle events (TaskComplete, TaskFailed, TurnAborted)

**Direction**: Service Worker (background) → Content Script (tab context)

**Delivery Method**: `chrome.tabs.sendMessage(tabId, message)`

**Message Structure**:
```typescript
interface EventMessage {
  type: 'EVENT';
  payload: {
    id: string;              // Event unique identifier (e.g., 'evt_42')
    msg: {
      type: 'TaskComplete' | 'TaskFailed' | 'TurnAborted';
      data: Record<string, any>;  // Event-specific payload
    };
  };
  timestamp?: number;         // Optional: When message was sent
}
```

**Example - TaskComplete**:
```json
{
  "type": "EVENT",
  "payload": {
    "id": "evt_42",
    "msg": {
      "type": "TaskComplete",
      "data": {}
    }
  },
  "timestamp": 1699876543210
}
```

**Example - TurnAborted**:
```json
{
  "type": "EVENT",
  "payload": {
    "id": "evt_43",
    "msg": {
      "type": "TurnAborted",
      "data": {
        "reason": "user_interrupt",
        "submission_id": "sub_123"
      }
    }
  },
  "timestamp": 1699876544320
}
```

**Response**:
```typescript
interface EventResponse {
  success: boolean;
}
```

**Sender Validation** (service-worker.ts):
```typescript
// ✓ Must check message.type === 'EVENT'
// ✓ Must check message.payload?.msg exists
// ✓ Must filter out restricted tabs (chrome://, chrome-extension://)
// ✓ Must handle sendMessage errors gracefully (.catch())
```

**Receiver Validation** (content-script.ts):
```typescript
// ✓ Must check message.type === 'EVENT'
// ✓ Must check message.payload?.msg exists
// ✓ Must check eventMsg.type is one of expected types
// ✓ Must respond with { success: true } and return true for async
```

**Error Conditions**:
- `"Could not establish connection"` - Content script not loaded or tab closed
- `"Message port closed"` - Service worker restarted mid-delivery
- `"Receiving end does not exist"` - No listener registered for this message type

---

### 2. PING Message (Bidirectional Verification)

**Purpose**: Verify that content script is loaded and message listeners are ready

**Direction**: Service Worker ↔ Content Script (bidirectional)

**Delivery Method**: `chrome.runtime.sendMessage()` or `chrome.tabs.sendMessage()`

**Request Structure**:
```typescript
interface PingMessage {
  type: 'PING';
  from: 'ServiceWorker' | 'VisualEffectController';
  timestamp?: number;
}
```

**Response Structure**:
```typescript
interface PongResponse {
  type: 'PONG';
  timestamp: number;
}
```

**Example Flow**:
```json
// Request (Service Worker → Content Script)
{
  "type": "PING",
  "from": "ServiceWorker",
  "timestamp": 1699876543210
}

// Response (Content Script → Service Worker)
{
  "type": "PONG",
  "timestamp": 1699876543250
}
```

**Usage Pattern**:
```typescript
// Service worker verifies content script is ready
async function verifyContentScriptReady(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PING',
      from: 'ServiceWorker',
      timestamp: Date.now()
    });
    return response?.type === 'PONG';
  } catch (error) {
    return false;
  }
}

// Content script verifies service worker is ready
async function verifyServiceWorkerReady(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PING',
      from: 'VisualEffectController',
      timestamp: Date.now()
    });
    return response?.type === 'PONG';
  } catch (error) {
    return false;
  }
}
```

**Error Conditions**:
- Timeout after 5 seconds → Content script not ready
- Connection error → Service worker restarted or extension context invalidated

---

### 3. DOM Custom Event (Content Script → Visual Effects Component)

**Purpose**: Bridge between content script and Svelte component to decouple message handling from visual effects

**Direction**: Content Script (top-level) → VisualEffectController (Svelte component)

**Delivery Method**: `document.dispatchEvent(new CustomEvent(...))`

**Event Structure**:
```typescript
interface TaskLifecycleCustomEvent extends CustomEvent {
  type: 'browserx:task-lifecycle';
  detail: {
    eventType: 'TaskComplete' | 'TaskFailed' | 'TurnAborted';
    timestamp?: number;
  };
}
```

**Example**:
```typescript
// Content script dispatches
document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', {
  detail: {
    eventType: 'TaskComplete',
    timestamp: Date.now()
  }
}));

// VisualEffectController listens
document.addEventListener('browserx:task-lifecycle', (event: Event) => {
  const customEvent = event as CustomEvent;
  const { eventType } = customEvent.detail;

  if (eventType === 'TaskComplete' ||
      eventType === 'TaskFailed' ||
      eventType === 'TurnAborted') {
    handleAgentStop();
  }
});
```

**Advantages of DOM Custom Events**:
1. **No Race Conditions**: Listener can be registered lazily in component lifecycle
2. **Decoupling**: Content script doesn't need to know about Svelte component internals
3. **Standard Pattern**: DOM events are standard, well-tested browser API
4. **Multiple Listeners**: Multiple components can listen to same event if needed

**Error Conditions**:
- None - DOM events are fire-and-forget, listeners register when ready

---

## Message Flow Diagram

```
┌─────────────────┐
│  BrowserxAgent  │
│   (src/core)    │
└────────┬────────┘
         │ emitEvent({ type: 'TaskComplete', data: {} })
         │
         ▼
chrome.runtime.sendMessage({ type: 'EVENT', payload: event })
         │
         ▼
┌─────────────────────────────────────┐
│      Service Worker                  │
│  chrome.runtime.onMessage.addListener│
│  (DIRECT listener, lines 197-230)   │
└──────────────┬──────────────────────┘
               │
               ▼
      chrome.tabs.query({})
      Filter: !url.startsWith('chrome://')
               │
               ▼ [for each injectable tab]
chrome.tabs.sendMessage(tabId, { type: 'EVENT', payload })
               │
               ▼
┌─────────────────────────────────────┐
│       Content Script                 │
│  chrome.runtime.onMessage.addListener│
│  (top-level registration)            │
└──────────────┬──────────────────────┘
               │
               ▼
document.dispatchEvent(new CustomEvent('browserx:task-lifecycle', ...))
               │
               ▼
┌─────────────────────────────────────┐
│   VisualEffectController.svelte      │
│  document.addEventListener(...)      │
└──────────────┬──────────────────────┘
               │
               ▼
       handleAgentStop()
         │
         ▼
   Clear visual effects:
   - overlayState.update({ visible: false })
   - waterRipple.turnOff()
   - resetStores()
```

## Contract Versioning

**Version**: 1.0.0
**Last Updated**: 2025-11-12

### Breaking Changes Policy

Changes that would break this contract:
1. Changing `message.type` from 'EVENT' to something else
2. Changing `message.payload` structure (removing `id` or `msg` fields)
3. Changing task lifecycle event types ('TaskComplete', etc.)
4. Changing DOM custom event name ('browserx:task-lifecycle')

If breaking changes are needed:
1. Add version field to message: `{ type: 'EVENT', version: 2, ... }`
2. Support both old and new formats during migration period
3. Update all senders and receivers before removing old format

### Non-Breaking Changes

Safe to add:
1. Additional optional fields in `message.payload.msg.data`
2. Additional task lifecycle event types (must be handled by receivers)
3. Additional metadata fields at top-level (`timestamp`, `source`, etc.)

## Testing Contract Compliance

### Unit Test Pattern

```typescript
describe('EVENT Message Contract', () => {
  it('should have correct structure', () => {
    const message = {
      type: 'EVENT',
      payload: {
        id: 'evt_123',
        msg: {
          type: 'TaskComplete',
          data: {}
        }
      }
    };

    expect(message.type).toBe('EVENT');
    expect(message.payload.id).toBeDefined();
    expect(message.payload.msg.type).toBe('TaskComplete');
  });

  it('should validate event types', () => {
    const validTypes = ['TaskComplete', 'TaskFailed', 'TurnAborted'];
    const message = { /* ... */ };

    expect(validTypes).toContain(message.payload.msg.type);
  });
});
```

### Integration Test Pattern

```typescript
describe('Message Delivery Chain', () => {
  it('should deliver EVENT from service worker to content script', async () => {
    // 1. Send EVENT from service worker
    const tabId = 123;
    const message = { type: 'EVENT', payload: { /* ... */ } };

    // 2. Verify content script receives message
    const response = await chrome.tabs.sendMessage(tabId, message);

    expect(response.success).toBe(true);
  });

  it('should dispatch DOM custom event after receiving EVENT', (done) => {
    // 1. Listen for DOM custom event
    document.addEventListener('browserx:task-lifecycle', (event) => {
      expect(event.detail.eventType).toBe('TaskComplete');
      done();
    });

    // 2. Trigger chrome.runtime.onMessage handler
    chrome.runtime.onMessage.dispatch({
      type: 'EVENT',
      payload: { msg: { type: 'TaskComplete' } }
    });
  });
});
```

## References

- **Chrome Extension Messaging API**: https://developer.chrome.com/docs/extensions/mv3/messaging/
- **Chrome Tabs API**: https://developer.chrome.com/docs/extensions/reference/tabs/
- **BrowserxAgent Source**: `src/core/BrowserxAgent.ts` lines 639-661
- **Service Worker Source**: `src/background/service-worker.ts` lines 197-230
- **VisualEffectController Source**: `src/content/ui_effect/VisualEffectController.svelte` lines 296-364
- **MessageRouter Source**: `src/core/MessageRouter.ts` lines 119-641
