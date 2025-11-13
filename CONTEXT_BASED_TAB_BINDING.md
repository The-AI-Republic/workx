# Context-Based Tab Binding Implementation

**Date**: 2025-11-12
**Branch**: 001-tab-manager
**Status**: ✅ Implemented

## Overview

Refactored the tab binding system to use **context-driven binding** instead of immediate binding. When users select a new tab in the UI, the tab is not immediately bound to the session. Instead, the tab binding happens when the user sends their next message, based on the `tabId` in the message context.

**Key Benefit**: Tab rebinding during active conversations no longer aborts running tasks - it only shows an informational notification.

## Problem Statement

**Previous Behavior**:
1. User selects new tab in TabContext dropdown
2. Immediate `UPDATE_SESSION_TAB` message sent to service worker
3. Service worker calls `tabManager.bindTabToSession()`
4. TabManager triggers `onTabUnbound` event with `reason: 'manual'`
5. BrowserxAgent handler aborts all running tasks
6. User sees confusing message: "The session is no longer bound to a tab. Tasks have been stopped."

**Issues**:
- Tasks were aborted even though user was actively selecting a new tab
- Notification was confusing (user intentionally selected the tab)
- Poor UX for switching tab context during conversations

## Solution

**New Behavior**:
1. User selects new tab in TabContext dropdown
2. `currentTabId` state updated locally (UI reflects selection)
3. **No immediate binding** - just log the selection
4. User sends a message with `context: { tabId: currentTabId }`
5. Service worker detects `context.tabId !== session.getTabId()`
6. Service worker calls `bindTabToSession(..., { silent: true })`
7. **Tasks continue running** (not aborted)
8. User sees informational notification: "Tab Context Changed: Now working in tab: {title}"

## Implementation Changes

### 1. Protocol Types (`src/protocol/types.ts`)

Added optional `context` field to `Submission` interface:

```typescript
export interface Submission {
  id: string;
  op: Op;
  context?: {
    tabId?: number;
  };
}
```

### 2. App.svelte (`src/sidepanel/App.svelte`)

**Updated `handleTabSelected()`**:
- Removed immediate `UPDATE_SESSION_TAB` message
- Only updates local `currentTabId` state
- Binding deferred until next message send

**Updated `sendMessage()`**:
- Added `context: { tabId: currentTabId }` to submission
- Tab context sent with every user message

```typescript
await router.sendSubmission({
  id: `user_${Date.now()}`,
  op: {
    type: 'UserInput',
    items: [{ type: 'text', text }],
  },
  context: {
    tabId: currentTabId,
  },
});
```

### 3. TabManager (`src/core/TabManager.ts`)

**Updated `bindTabToSession()` signature**:
- Added optional `options?: { silent?: boolean }` parameter
- When `silent: true`, skips all `notifyTabUnbound()` calls
- Returns `{ previousTabId, switchedFromTab }` to indicate if tab changed

```typescript
async bindTabToSession(
  sessionId: string,
  tabId: number,
  tabInfo: Pick<TabInfo, 'title' | 'url'>,
  options?: { silent?: boolean }
): Promise<{ previousTabId?: number; switchedFromTab: boolean }>
```

**Silent Mode Behavior**:
- No `onTabUnbound` events triggered
- No task abortion
- No notifications from TabManager
- Caller responsible for showing appropriate notifications

### 4. Service Worker (`src/background/service-worker.ts`)

**Updated `SUBMISSION` handler**:
- Checks if `submission.context?.tabId` exists
- Compares `context.tabId` with `session.getTabId()`
- If different, rebinds tab with `{ silent: true }`
- Shows informational notification after successful rebind
- **Does not abort tasks**

```typescript
router.on(MessageType.SUBMISSION, async (message) => {
  const submission = message.payload as Submission;

  // Check if context contains a tabId that differs from current session tabId
  if (submission.context?.tabId !== undefined) {
    const contextTabId = submission.context.tabId;
    const currentTabId = session.getTabId();

    if (contextTabId !== currentTabId) {
      // Bind tab with silent=true (no notifications, no task abortion)
      const result = await tabManager.bindTabToSession(
        sessionId,
        contextTabId,
        { title, url },
        { silent: true }
      );

      session.setTabId(contextTabId);

      // Show informational notification (but don't abort tasks)
      if (result.switchedFromTab) {
        await notifier.notifyInfo(
          'Tab Context Changed',
          `Now working in tab: ${tab.title}`
        );
      }
    }
  }

  // Continue with operation submission
  const id = await agent.submitOperation(submission.op);
  return { submissionId: id };
});
```

## Key Differences from Previous Behavior

| Aspect | Previous (Immediate Binding) | New (Context-Based Binding) |
|--------|------------------------------|------------------------------|
| **Trigger** | Tab selection in dropdown | First message after tab selection |
| **Message** | `UPDATE_SESSION_TAB` | `SUBMISSION` with `context.tabId` |
| **Timing** | Immediate (before user sends message) | Deferred (when user sends message) |
| **Task Handling** | ❌ Aborts all running tasks | ✅ **Tasks continue running** |
| **Notification** | ⚠️ "Session no longer bound to tab" | ℹ️ "Tab Context Changed: Now working in..." |
| **Event Triggered** | `onTabUnbound(reason: 'manual')` | None (silent binding) |

## Testing Scenarios

### Scenario 1: User switches tabs and sends message (no active tasks)

1. User has session bound to Tab A
2. User selects Tab B from dropdown
   - **Expected**: UI updates, no backend messages
3. User sends message "hello"
   - **Expected**:
     - Service worker rebinds session to Tab B
     - Notification: "Tab Context Changed: Now working in tab: {Tab B title}"
     - Message processed normally

### Scenario 2: User switches tabs while task is running

1. User has session bound to Tab A
2. Agent is running a long task (e.g., DOM snapshot, API call)
3. User selects Tab B from dropdown
   - **Expected**: UI updates, task continues running
4. User sends message "hello"
   - **Expected**:
     - Service worker rebinds session to Tab B
     - **Task continues running** (not aborted)
     - Notification: "Tab Context Changed: Now working in tab: {Tab B title}"
     - Message queued after current task completes

### Scenario 3: User selects tab but doesn't send message

1. User has session bound to Tab A
2. User selects Tab B from dropdown
   - **Expected**: UI updates, no backend binding
3. User closes sidepanel
4. User reopens sidepanel
   - **Expected**: Session still bound to Tab A (binding never happened)

### Scenario 4: User unbinds tab (selects "No Tab")

1. User has session bound to Tab A
2. User selects "No Tab" from dropdown
   - **Expected**: `currentTabId = -1`, UI updates
3. User sends message
   - **Expected**:
     - Service worker unbinds session
     - `session.setTabId(-1)`
     - Tool calls will fail (no tab context)

## Migration Notes

### Backward Compatibility

- ✅ Existing `UPDATE_SESSION_TAB` handler still exists (used for initial auto-binding)
- ✅ `bindTabToSession()` default behavior unchanged (no options = normal behavior)
- ✅ Tests that don't pass `{ silent: true }` continue to work

### Breaking Changes

- **None** - this is purely additive functionality

### Deprecated Paths

- `UPDATE_SESSION_TAB` is no longer used for manual tab selection
- Still used for initial auto-binding on sidepanel mount

## Future Enhancements

1. **Proactive Binding**: Show a badge/indicator when tab selection changed but binding hasn't happened yet
2. **Confirmation Dialog**: Ask user "Switch tab context to {new tab}?" before rebinding
3. **Auto-Rebind**: Automatically rebind without message if no tasks are running
4. **Tab Validation**: Check if new tab is valid/accessible before accepting the selection
5. **Rollback**: Allow user to undo accidental tab switches

## Related Documentation

- [TAB_UNBIND_BUG_FIX.md](./TAB_UNBIND_BUG_FIX.md) - Original tab unbinding issue
- [DELAY_FIX_RECOMMENDATIONS.md](./DELAY_FIX_RECOMMENDATIONS.md) - Performance optimizations
- [CLAUDE.md](./CLAUDE.md) - Project development guidelines

## Console Logging

**For Debugging**:

When tab switching happens, you'll see:
```
[App] Tab selected: 123 (will bind on next message)
[ServiceWorker] Context tabId (123) differs from session tabId (456), rebinding...
[TabManager] Tab 123 rebound from session abc to abc (silent mode)
[ServiceWorker] Session abc rebound to tab 123
```

When no tab change detected:
```
(No logs - context tabId matches session tabId, no rebinding needed)
```

## Summary

This refactor improves UX by:
- ✅ Eliminating unnecessary task aborts when switching tabs
- ✅ Providing clear, informational notifications
- ✅ Deferring binding until user actually needs it (sends message)
- ✅ Maintaining backward compatibility with existing code
- ✅ Giving users control over when context switches happen

The context-based approach aligns with the principle of **least surprise** - users expect that selecting a tab prepares it for use, but doesn't disrupt ongoing work until they explicitly interact with the new context.
