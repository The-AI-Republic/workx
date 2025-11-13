# Tab Unbinding Bug Fix

## Problem

When a tab was rebound from one session to another (or a session switched tabs), the code was incorrectly calling `notifyTabClosed()`, which:

1. **Showed wrong notification**: "Tab Closed" even though the tab was still open
2. **Aborted all tasks**: Tasks were stopped as if the tab had crashed/closed
3. **Confused users**: The tab wasn't actually closed, just reassigned

### Root Cause

In `TabManager.bindTabToSession()` (line 89):

```typescript
// When tab is stolen by another session
if (existingSessionId && existingSessionId !== sessionId) {
  this.sessionToTab.delete(existingSessionId);

  // BUG: Tab is NOT closed, just reassigned!
  this.notifyTabClosed(existingSessionId, tabId);
}
```

This triggered the closure handler in `BrowserxAgent`, which:
- Showed "Tab Closed" notification
- Aborted all running tasks
- But the tab was still open!

## Solution

Created **two separate event types**:

### 1. `onTabClosed` - Tab Actually Closed
- **When**: Tab is closed in browser (`chrome.tabs.onRemoved`) or crashes
- **Action**: Abort tasks, show "Tab Closed" warning
- **Use**: Actual tab closure events

### 2. `onTabUnbound` - Session Loses Tab (Tab Still Open)
- **When**:
  - Tab is rebound to another session (`reason: 'rebind'`)
  - Session manually switches to different tab (`reason: 'manual'`)
- **Action**: Abort tasks, show informational message about tab loss
- **Use**: Tab reassignment events

### Changes Made

#### [TabManager.ts](src/core/TabManager.ts)

**Added new callback type:**
```typescript
export type TabUnboundCallback = (
  sessionId: string,
  oldTabId: number,
  reason: 'rebind' | 'manual'
) => void;
```

**Added registration method:**
```typescript
onTabUnbound(callback: TabUnboundCallback): void {
  this.tabUnboundCallbacks.push(callback);
}
```

**Updated `bindTabToSession()`:**
```typescript
// When tab stolen by another session
if (existingSessionId && existingSessionId !== sessionId) {
  this.sessionToTab.delete(existingSessionId);

  // FIXED: Notify unbind, not closure
  this.notifyTabUnbound(existingSessionId, tabId, 'rebind');
}

// When session switches to different tab
if (existingTabId && existingTabId !== tabId) {
  this.tabToSession.delete(existingTabId);
  this.bindings.delete(existingTabId);

  // FIXED: Notify unbind, not closure
  this.notifyTabUnbound(sessionId, existingTabId, 'manual');
}
```

#### [BrowserxAgent.ts](src/core/BrowserxAgent.ts)

**Separated handlers:**

```typescript
// Handle actual tab closure (tab closed in browser)
tabBindingManager.onTabClosed(async (sessionId, tabId) => {
  this.session.setTabId(-1);
  await this.session.abortAllTasks('TabClosed');

  await this.userNotifier.notifyWarning(
    'Tab Closed',
    'The tab was closed. All tasks have been stopped.'
  );
});

// Handle tab unbinding (session loses tab, but tab still open)
tabBindingManager.onTabUnbound(async (sessionId, tabId, reason) => {
  this.session.setTabId(-1);
  await this.session.abortAllTasks('TabClosed');

  if (reason === 'rebind') {
    await this.userNotifier.notifyInfo(
      'Tab Reassigned',
      'The tab was reassigned to another session. Tasks have been stopped.'
    );
  } else {
    await this.userNotifier.notifyInfo(
      'Tab Changed',
      'The session is no longer bound to a tab. Tasks have been stopped.'
    );
  }
});
```

## Benefits

✅ **Accurate notifications**: Users see the correct reason for task stoppage
✅ **Clear semantics**: Code clearly distinguishes between closure and unbinding
✅ **Better UX**: Different notification levels (warning vs info) for different scenarios
✅ **Maintainability**: Intent is explicit in code and event names

## Testing

**Scenario 1: Tab Actually Closed**
- User closes tab while tasks running
- **Expected**: Warning notification "Tab Closed", tasks aborted
- **Result**: ✅ Works correctly (unchanged behavior)

**Scenario 2: Tab Reassigned to Another Session**
- Session A has tab 123
- Session B binds to tab 123
- **Expected**: Session A gets info notification "Tab Reassigned", tasks aborted
- **Result**: ✅ Fixed - was showing "Tab Closed" before

**Scenario 3: Session Switches Tabs**
- Session has tab 123
- User manually binds session to tab 456
- **Expected**: Info notification "Tab Changed", tasks aborted
- **Result**: ✅ New behavior - previously not handled

## Related Changes

Also updated `TaskRunner.ts` to get `tabId` from `session.getTabId()` instead of the now-removed `turnContext.getTabId()` (part of the larger refactoring to centralize tabId in SessionState).
