# Channel-Thread Event Routing Design

## 1. Problem Statement

The message routing system currently has no formal distinction between **channel-level events** and **thread-level events**. A thread is a sub-unit of a channel — each channel can have multiple threads (sessions), but some events belong to the channel as a whole, not to any specific thread.

### Current Architecture

```
Backend Agent
    ↓ emits EventMsg
AgentRegistry callback (stamps sessionId)
    ↓
ChannelManager.dispatchEvent({ msg, sessionId })
    ↓
Channel.sendEvent(ChannelEvent)
    ↓ wire (chrome.runtime / tauri / websocket)
Transport reconstructs ChannelEvent { msg, sessionId }
    ↓
UIChannelClient.handleChannelEvent(channelEvent)
    ↓
    ├── typed handlers: handler(eventData)       ← sessionId STRIPPED
    └── wildcard handler: handler(channelEvent)  ← sessionId available
```

### Three Problems

**1. No event-level routing semantics.** Every `EventMsg` is treated the same — there's no way to declare whether an event targets a specific thread, all threads, or the channel itself. The system relies on the presence/absence of `sessionId` as an implicit signal, but this isn't formalized anywhere.

**2. `UIChannelClient` strips routing info from typed handlers.** In `handleChannelEvent()` (UIChannelClient.ts:193-199), typed event handlers receive only `event.data` — the `sessionId` from the `ChannelEvent` envelope is discarded. Only wildcard handlers get the full `ChannelEvent`. This forces the frontend to use a single wildcard handler for all thread routing instead of composing typed handlers.

```typescript
// Current: typed handler gets bare payload, no routing info
client.onEvent('AgentMessageDelta', (data) => {
    // data = { delta: 'hello' }
    // Which thread? Unknown.
});

// Workaround: wildcard handler gets full ChannelEvent
client.onEvent('*', (channelEvent) => {
    const sessionId = channelEvent?.sessionId;
    // Now we can route, but we lost typed dispatch
});
```

**3. Thread routing is ad-hoc in the UI layer.** `Main.svelte` implements thread routing via a monolithic wildcard handler (lines 145-162) that manually checks `sessionId === activeSessionId`. There's no reusable routing layer — every component that needs session-aware events must reimplement this logic or go through the wildcard path.

### The Missing Concept

Events fall into two categories, but the system doesn't distinguish them:

| Category | Examples | Routing Target |
|----------|----------|----------------|
| **Channel-level** | `BackgroundEvent`, `StateUpdate`, `SessionConfigured`, `Notification`, `ServiceResponse`, `ShutdownComplete` | The channel UI itself (settings panel, status bar, session list) |
| **Thread-level** | `AgentMessageDelta`, `TaskStarted`, `ToolExecutionStart`, `ExecApprovalRequest`, `TurnComplete`, `AgentReasoning*` | A specific thread/session's conversation view |

Currently, the channel has no mechanism to route thread-level events to the correct thread, and no mechanism to handle channel-level events separately. Everything goes into one wildcard handler.

## 2. Design Goals

1. **Formalize event routing scope** — each event type should declare whether it targets a thread or the channel
2. **Preserve `sessionId` through the handler chain** — typed handlers should receive routing info
3. **Provide a reusable thread dispatch layer** — UI components shouldn't each reimplement session filtering
4. **Backward compatible** — existing wildcard handler pattern continues to work
5. **Platform agnostic** — works across extension, desktop, and server channels

## 3. Proposed Design

### 3.1 Event Scope Classification

Add a scope concept to events. Rather than modifying every `EventMsg` variant, define a static lookup:

```typescript
// src/core/protocol/event-scope.ts

export type EventScope = 'thread' | 'channel';

/**
 * Static mapping of EventMsg.type to its routing scope.
 * Thread-scoped events MUST have a sessionId to be routable.
 * Channel-scoped events are delivered to channel-level handlers regardless of sessionId.
 */
const EVENT_SCOPE_MAP: Record<string, EventScope> = {
    // Thread-scoped: conversation/turn lifecycle
    'TaskStarted': 'thread',
    'TaskComplete': 'thread',
    'TaskFailed': 'thread',
    'TurnStarted': 'thread',
    'TurnComplete': 'thread',
    'TurnAborted': 'thread',
    'Interrupted': 'thread',

    // Thread-scoped: streaming content
    'AgentMessage': 'thread',
    'AgentMessageDelta': 'thread',
    'UserMessage': 'thread',
    'AgentReasoning': 'thread',
    'AgentReasoningDelta': 'thread',
    'AgentReasoningRawContent': 'thread',
    'AgentReasoningRawContentDelta': 'thread',
    'AgentReasoningSectionBreak': 'thread',
    'ReasoningSummaryDelta': 'thread',
    'ReasoningContentDelta': 'thread',
    'ReasoningSummaryPartAdded': 'thread',

    // Thread-scoped: tool execution
    'ToolExecutionStart': 'thread',
    'ToolExecutionEnd': 'thread',
    'ToolExecutionError': 'thread',
    'ToolExecutionTimeout': 'thread',
    'McpToolCallBegin': 'thread',
    'McpToolCallEnd': 'thread',
    'ExecCommandBegin': 'thread',
    'ExecCommandOutputDelta': 'thread',
    'ExecCommandEnd': 'thread',
    'WebSearchBegin': 'thread',
    'WebSearchEnd': 'thread',

    // Thread-scoped: approvals
    'ExecApprovalRequest': 'thread',
    'ApplyPatchApprovalRequest': 'thread',
    'ApprovalRequested': 'thread',
    'ApprovalGranted': 'thread',
    'ApprovalDenied': 'thread',
    'ApprovalAutoApproved': 'thread',
    'PatchApplyBegin': 'thread',
    'PatchApplyEnd': 'thread',

    // Thread-scoped: browser actions
    'DOMActionStart': 'thread',
    'StorageActionStart': 'thread',
    'NavigationActionStart': 'thread',

    // Thread-scoped: diff tracking
    'ChangeAdded': 'thread',
    'ChangesRetrieved': 'thread',
    'RollbackStarted': 'thread',
    'BatchRollbackStarted': 'thread',
    'SessionRollbackStarted': 'thread',
    'RollbackCompleted': 'thread',
    'SnapshotCreated': 'thread',
    'SnapshotRestored': 'thread',
    'ChangesCleared': 'thread',

    // Thread-scoped: other per-conversation events
    'TurnDiff': 'thread',
    'TurnRetry': 'thread',
    'ContextUpdated': 'thread',
    'CompactionCompleted': 'thread',
    'EnteredReviewMode': 'thread',
    'ExitedReviewMode': 'thread',
    'PlanUpdate': 'thread',
    'TaskUpdate': 'thread',
    'ConversationPath': 'thread',
    'GetHistoryEntryResponse': 'thread',

    // Channel-scoped: global/settings events
    'BackgroundEvent': 'channel',
    'StateUpdate': 'channel',
    'SessionConfigured': 'channel',
    'Notification': 'channel',
    'ShutdownComplete': 'channel',
    'Error': 'channel',
    'StreamError': 'channel',
    'TokenCount': 'channel',
    'McpListToolsResponse': 'channel',
    'ListCustomPromptsResponse': 'channel',

    // Service routing (handled separately by UIChannelClient)
    'ServiceResponse': 'channel',
};

export function getEventScope(type: string): EventScope {
    return EVENT_SCOPE_MAP[type] ?? 'channel'; // default to channel for unknown
}
```

### 3.2 Pass `ChannelEvent` to Typed Handlers

Modify `UIChannelClient.handleChannelEvent()` to pass the full `ChannelEvent` to typed handlers instead of just `eventData`:

```typescript
// UIChannelClient.ts — proposed change

private handleChannelEvent(channelEvent: ChannelEvent): void {
    const event = channelEvent.msg;

    // ServiceResponse handling (unchanged)
    if (event.type === 'ServiceResponse') { /* ... existing logic ... */ }

    // Typed handlers — now receive full ChannelEvent
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(channelEvent);  // was: handler(eventData)
      }
    }

    // Wildcard handlers (unchanged)
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(channelEvent);
      }
    }
}
```

Update handler type signature:

```typescript
// Before:
onEvent(type: string, handler: (data: any) => void): () => void;

// After:
onEvent(type: string, handler: (event: ChannelEvent) => void): () => void;
```

### 3.3 Thread-Aware Event Router (Frontend)

Add a reusable router that sits between `UIChannelClient` and UI components:

```typescript
// src/webfront/routing/ThreadEventRouter.ts

import { getEventScope } from '@/core/protocol/event-scope';
import type { ChannelEvent } from '@/core/channels/types';

type ThreadEventHandler = (event: ChannelEvent) => void;
type ChannelEventHandler = (event: ChannelEvent) => void;

/**
 * Routes ChannelEvents to thread-specific or channel-level handlers
 * based on the event's scope classification and sessionId.
 */
export class ThreadEventRouter {
    private activeSessionId: string | null = null;
    private activeThreadHandler: ThreadEventHandler | null = null;
    private backgroundThreadHandler: ThreadEventHandler | null = null;
    private channelHandler: ChannelEventHandler | null = null;

    setActiveSession(sessionId: string | null): void {
        this.activeSessionId = sessionId;
    }

    /**
     * Handler for events targeting the currently active/visible thread.
     */
    onActiveThread(handler: ThreadEventHandler): void {
        this.activeThreadHandler = handler;
    }

    /**
     * Handler for events targeting a background (non-visible) thread.
     * Typically buffers these for later display.
     */
    onBackgroundThread(handler: ThreadEventHandler): void {
        this.backgroundThreadHandler = handler;
    }

    /**
     * Handler for channel-level events (not tied to a thread).
     */
    onChannel(handler: ChannelEventHandler): void {
        this.channelHandler = handler;
    }

    /**
     * Route an incoming ChannelEvent to the appropriate handler.
     */
    route(channelEvent: ChannelEvent): void {
        const scope = getEventScope(channelEvent.msg.type);

        if (scope === 'channel') {
            this.channelHandler?.(channelEvent);
            return;
        }

        // Thread-scoped event
        const sessionId = channelEvent.sessionId;
        if (!sessionId) {
            // Thread event without sessionId — drop it
            console.warn(`[ThreadEventRouter] Thread event ${channelEvent.msg.type} missing sessionId, dropping`);
            return;
        }

        if (sessionId === this.activeSessionId) {
            this.activeThreadHandler?.(channelEvent);
        } else {
            this.backgroundThreadHandler?.(channelEvent);
        }
    }
}
```

### 3.4 Usage in Main.svelte

Replace the monolithic wildcard handler with the router:

```typescript
// Before (current):
const HANDLED_EVENT_TYPES = new Set(['StateUpdate', 'BackgroundEvent', 'ServiceResponse']);
client.onEvent('*', (channelEvent: any) => {
    const eventMsg = channelEvent?.msg ?? channelEvent;
    if (HANDLED_EVENT_TYPES.has(eventMsg?.type)) return;
    const event = { id: `evt_${Date.now()}`, msg: eventMsg };
    const eventSessionId = channelEvent?.sessionId;
    if (eventSessionId && eventSessionId === activeSessionId) {
        handleEvent(event);
    } else if (eventSessionId) {
        handleEventForSession(event, eventSessionId);
    }
});
client.onEvent('StateUpdate', (data) => { /* ... */ });
client.onEvent('BackgroundEvent', (data) => { /* ... */ });

// After (proposed):
const router = new ThreadEventRouter();
router.setActiveSession(activeSessionId);

router.onActiveThread((channelEvent) => {
    const event = { id: `evt_${Date.now()}`, msg: channelEvent.msg };
    handleEvent(event);
});

router.onBackgroundThread((channelEvent) => {
    const event = { id: `evt_${Date.now()}`, msg: channelEvent.msg };
    handleEventForSession(event, channelEvent.sessionId!);
});

router.onChannel((channelEvent) => {
    const { msg } = channelEvent;
    if (msg.type === 'StateUpdate' && 'data' in msg) { /* ... */ }
    if (msg.type === 'BackgroundEvent' && 'data' in msg) { /* ... */ }
});

// Single wildcard handler feeds the router
client.onEvent('*', (channelEvent) => router.route(channelEvent));
```

When `activeSessionId` changes (thread switch):
```typescript
function switchToThread(sessionId: string) {
    saveThreadState(activeSessionId);
    activeSessionId = sessionId;
    router.setActiveSession(sessionId);  // router immediately starts routing to new thread
    loadThreadState(sessionId);
}
```

## 4. Backend Event Emission — Fixing `AgentRegistry._emitEvent()`

The `AgentRegistry._emitEvent()` (line 422-428) currently bypasses the `ChannelEvent` envelope:

```typescript
// Current (broken):
getChannelManager().broadcastEvent({
    type: 'BackgroundEvent' as any,
    data: { message: 'session_event', level: 'info', sessionEvent: event },
} as any)

// Fixed:
getChannelManager().broadcastEvent({
    msg: {
        type: 'BackgroundEvent',
        data: { message: 'session_event', level: 'info', sessionEvent: event },
    },
    // No sessionId — this is a channel-level event
})
```

This is a channel-scoped event (session lifecycle metadata), so it correctly has no `sessionId`. The router will deliver it to `onChannel()` handlers.

## 5. Event Scope Summary

### Thread-scoped (~45 event types)
Events produced by a specific agent session during a conversation turn. Always have `sessionId`. Route to the thread that owns that session.

### Channel-scoped (~12 event types)
Events about global state, configuration, session lifecycle, or service responses. May or may not have `sessionId`. Delivered to channel-level handlers regardless.

## 6. Files to Change

| File | Change |
|------|--------|
| `src/core/protocol/event-scope.ts` | **New** — event scope classification map |
| `src/core/messaging/UIChannelClient.ts` | Pass `ChannelEvent` to typed handlers instead of bare `eventData` |
| `src/webfront/routing/ThreadEventRouter.ts` | **New** — reusable thread/channel event router |
| `src/webfront/pages/chat/Main.svelte` | Replace wildcard handler with `ThreadEventRouter` |
| `src/core/registry/AgentRegistry.ts` | Fix `_emitEvent()` to use proper `ChannelEvent` envelope |
| `src/webfront/stores/threadStore.ts` | No change needed (already tracks `activeSessionId`) |
| `src/core/channels/types.ts` | No change needed (`ChannelEvent` already has `sessionId`) |

## 7. Migration Path

1. **Add `event-scope.ts`** — pure addition, no breaking changes
2. **Add `ThreadEventRouter`** — pure addition, no breaking changes
3. **Fix `AgentRegistry._emitEvent()`** — bug fix, removes `as any` casts
4. **Update `UIChannelClient` handler signature** — breaking change to typed handler consumers
5. **Update `Main.svelte`** — adopt `ThreadEventRouter`, remove ad-hoc wildcard logic
6. **Update other `onEvent()` consumers** — adapt to new `ChannelEvent` signature

Step 4 is the only breaking change. All existing `onEvent(type, fn)` call sites need to update from `(data) => ...` to `(channelEvent) => channelEvent.msg.data...`. This can be done incrementally.

## 8. Relationship to Existing Design Docs

This design builds on top of **message_routing_v2** (`.ai_design/message_routing_v2/design.md`), which unified the transport layer by replacing `MessageRouter` with `ChannelAdapter/ChannelManager`. That work established the `ChannelEvent { msg, sessionId }` envelope but didn't address the thread-level routing problem within a channel.

This design addresses the **last mile** — how events get from the channel to the correct thread in the UI.
