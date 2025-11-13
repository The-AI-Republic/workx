# API Contract: TabManager

**Feature**: 001-tab-manager | **Date**: 2025-11-12 | **Phase**: 1 (Design)

## Overview

This document defines the API contract for TabManager, specifying all public methods, types, events, and behavioral guarantees. This contract serves as the source of truth for contract tests and ensures consistent behavior across the refactoring.

---

## TabManager Class

### Singleton Pattern

```typescript
class TabManager {
  private static instance: TabManager | null = null;

  static getInstance(): TabManager;
}
```

**Contract**:
- ✅ MUST return the same instance across all calls within same execution context
- ✅ MUST create new instance on first call if none exists
- ✅ MUST NOT allow direct instantiation via `new TabManager()`

**Test**:
```typescript
describe('TabManager.getInstance()', () => {
  it('returns singleton instance', () => {
    const instance1 = TabManager.getInstance();
    const instance2 = TabManager.getInstance();
    expect(instance1).toBe(instance2);
  });
});
```

---

### initialize()

```typescript
initialize(): Promise<void>
```

**Contract**:
- ✅ MUST be idempotent (safe to call multiple times)
- ✅ MUST register chrome.tabs.onRemoved listener
- ✅ MUST register chrome.tabs.onUpdated listener
- ✅ MUST query for existing "browserx" tab group
- ✅ MUST set `this.initialized = true` on success
- ✅ MUST return resolved Promise on subsequent calls if already initialized
- ⚠️ MAY throw if Chrome APIs unavailable

**Preconditions**: None

**Postconditions**:
- `this.initialized === true`
- Tab event listeners registered

**Test**:
```typescript
describe('TabManager.initialize()', () => {
  it('sets up event listeners', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    // Verify listeners registered
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(true);
    expect(chrome.tabs.onUpdated.hasListeners()).toBe(true);
  });

  it('is idempotent', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.initialize(); // Should not throw
    expect(manager['initialized']).toBe(true);
  });
});
```

---

### bindTabToSession()

```typescript
bindTabToSession(
  sessionId: string,
  tabId: number,
  tabInfo: TabInfo
): Promise<void>
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `sessionId` | `string` | Non-empty, pattern: `conv_.*` | Session identifier |
| `tabId` | `number` | Positive integer | Chrome tab ID |
| `tabInfo` | `TabInfo` | `{title?: string, url?: string}` | Tab metadata |

**Contract**:
- ✅ MUST create bidirectional mapping (tabId ↔ sessionId)
- ✅ MUST store TabBindingState in this.bindings
- ✅ MUST implement last-write-wins if tab already bound to different session
- ✅ MUST notify previous session via onTabClosed callback if rebinding
- ✅ MUST add tab to "browserx" tab group (create group if not exists)
- ✅ MUST unbind session's previous tab if session was bound to different tab
- ⚠️ MAY fail if tab does not exist (Chrome API error)
- ⚠️ MAY fail if tab group creation fails (logs warning, continues without grouping)

**Preconditions**:
- `this.initialized === true`
- `sessionId` is non-empty string
- `tabId` is positive integer

**Postconditions**:
- `this.tabToSession.get(tabId) === sessionId`
- `this.sessionToTab.get(sessionId) === tabId`
- `this.bindings.has(tabId) === true`
- Tab belongs to "browserx" group (if grouping succeeded)

**Side Effects**:
- If previous session bound to `tabId`, that session's binding is removed
- If current session bound to different tab, that tab's binding is removed
- `onTabClosed` callbacks invoked for unbound sessions

**Test**:
```typescript
describe('TabManager.bindTabToSession()', () => {
  it('creates bidirectional binding', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    await manager.bindTabToSession('conv_123', 456, { title: 'Test', url: 'https://example.com' });

    expect(manager.getTabForSession('conv_123')).toBe(456);
    expect(manager.getSessionForTab(456)).toBe('conv_123');
  });

  it('implements last-write-wins for same tab', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    await manager.bindTabToSession('conv_A', 123, {});
    await manager.bindTabToSession('conv_B', 123, {}); // Rebind to B

    expect(manager.getSessionForTab(123)).toBe('conv_B');
    expect(manager.getTabForSession('conv_A')).toBe(-1); // A lost binding
  });

  it('adds tab to browserx group', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    await manager.bindTabToSession('conv_123', 456, {});

    const tab = await chrome.tabs.get(456);
    expect(tab.groupId).toBe(manager['groupId']);
  });
});
```

---

### unbindTab()

```typescript
unbindTab(tabId: number): void
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `tabId` | `number` | Any number | Tab ID to unbind |

**Contract**:
- ✅ MUST remove tabId from this.tabToSession
- ✅ MUST remove corresponding sessionId from this.sessionToTab
- ✅ MUST remove tabId from this.bindings
- ✅ MUST be no-op if tabId not bound
- ✅ MUST NOT throw if tabId invalid

**Preconditions**: None

**Postconditions**:
- `!this.tabToSession.has(tabId)`
- `!this.bindings.has(tabId)`
- Previous sessionId (if any) no longer maps to tabId

**Test**:
```typescript
describe('TabManager.unbindTab()', () => {
  it('removes binding', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    manager.unbindTab(456);

    expect(manager.getSessionForTab(456)).toBeUndefined();
    expect(manager.getTabForSession('conv_123')).toBe(-1);
  });

  it('is no-op for unbound tab', () => {
    const manager = TabManager.getInstance();
    expect(() => manager.unbindTab(999)).not.toThrow();
  });
});
```

---

### unbindSession()

```typescript
unbindSession(sessionId: string): void
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `sessionId` | `string` | Any string | Session ID to unbind |

**Contract**:
- ✅ MUST remove sessionId from this.sessionToTab
- ✅ MUST remove corresponding tabId from this.tabToSession
- ✅ MUST remove corresponding tabId from this.bindings
- ✅ MUST be no-op if sessionId not bound
- ✅ MUST NOT throw if sessionId invalid

**Preconditions**: None

**Postconditions**:
- `!this.sessionToTab.has(sessionId)`
- Previous tabId (if any) no longer bound

**Test**:
```typescript
describe('TabManager.unbindSession()', () => {
  it('removes binding', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    manager.unbindSession('conv_123');

    expect(manager.getTabForSession('conv_123')).toBe(-1);
    expect(manager.getSessionForTab(456)).toBeUndefined();
  });
});
```

---

### getSessionForTab()

```typescript
getSessionForTab(tabId: number): string | undefined
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `tabId` | `number` | Any number | Tab ID to look up |

**Contract**:
- ✅ MUST return sessionId if tab is bound
- ✅ MUST return undefined if tab is not bound
- ✅ MUST complete in O(1) time (map lookup)
- ✅ MUST NOT throw

**Preconditions**: None

**Postconditions**: None (read-only)

**Test**:
```typescript
describe('TabManager.getSessionForTab()', () => {
  it('returns sessionId for bound tab', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    expect(manager.getSessionForTab(456)).toBe('conv_123');
  });

  it('returns undefined for unbound tab', () => {
    const manager = TabManager.getInstance();
    expect(manager.getSessionForTab(999)).toBeUndefined();
  });
});
```

---

### getTabForSession()

```typescript
getTabForSession(sessionId: string): number
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `sessionId` | `string` | Any string | Session ID to look up |

**Contract**:
- ✅ MUST return tabId (positive integer) if session is bound
- ✅ MUST return -1 if session is not bound
- ✅ MUST complete in O(1) time (map lookup)
- ✅ MUST NOT throw

**Preconditions**: None

**Postconditions**: None (read-only)

**Test**:
```typescript
describe('TabManager.getTabForSession()', () => {
  it('returns tabId for bound session', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    expect(manager.getTabForSession('conv_123')).toBe(456);
  });

  it('returns -1 for unbound session', () => {
    const manager = TabManager.getInstance();
    expect(manager.getTabForSession('conv_unknown')).toBe(-1);
  });
});
```

---

### getBinding()

```typescript
getBinding(tabId: number): TabBindingState | undefined
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `tabId` | `number` | Any number | Tab ID to look up |

**Contract**:
- ✅ MUST return TabBindingState if tab is bound
- ✅ MUST return undefined if tab is not bound
- ✅ MUST return deep copy or immutable object (prevent mutation)
- ✅ MUST complete in O(1) time

**Preconditions**: None

**Postconditions**: None (read-only)

**Test**:
```typescript
describe('TabManager.getBinding()', () => {
  it('returns binding metadata', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, { title: 'Test Tab', url: 'https://example.com' });

    const binding = manager.getBinding(456);

    expect(binding).toMatchObject({
      tabId: 456,
      sessionId: 'conv_123',
      tabTitle: 'Test Tab',
      tabUrl: 'https://example.com',
    });
    expect(binding.boundAt).toBeGreaterThan(Date.now() - 1000); // Recent timestamp
  });
});
```

---

### validateTab()

```typescript
validateTab(tabId: number): Promise<TabValidationState>
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `tabId` | `number` | Any number | Tab ID to validate |

**Contract**:
- ✅ MUST return `{status: 'invalid', reason: NOT_FOUND}` if tabId === -1
- ✅ MUST query chrome.tabs.get(tabId) for other tab IDs
- ✅ MUST return `{status: 'valid', tab: chrome.tabs.Tab}` if tab exists
- ✅ MUST return `{status: 'invalid', reason: CLOSED}` if tab does not exist
- ✅ MUST return `{status: 'invalid', reason: PERMISSION_DENIED}` if permission error
- ✅ MUST complete within 100ms (performance requirement)

**Preconditions**: None (can validate any tabId)

**Postconditions**: None (read-only check)

**Test**:
```typescript
describe('TabManager.validateTab()', () => {
  it('returns valid for existing tab', async () => {
    const manager = TabManager.getInstance();
    const mockTab = { id: 123, title: 'Test', url: 'https://example.com' };
    chrome.tabs.get = vi.fn().mockResolvedValue(mockTab);

    const result = await manager.validateTab(123);

    expect(result).toEqual({ status: 'valid', tab: mockTab });
  });

  it('returns invalid for tabId = -1', async () => {
    const manager = TabManager.getInstance();

    const result = await manager.validateTab(-1);

    expect(result).toEqual({ status: 'invalid', reason: TabInvalidReason.NOT_FOUND });
  });

  it('returns invalid for closed tab', async () => {
    const manager = TabManager.getInstance();
    chrome.tabs.get = vi.fn().mockRejectedValue(new Error('No tab with id: 999'));

    const result = await manager.validateTab(999);

    expect(result).toEqual({ status: 'invalid', reason: TabInvalidReason.CLOSED });
  });
});
```

---

### createAndBindTab()

```typescript
createAndBindTab(
  sessionId: string,
  options: { url: string }
): Promise<number | null>
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `sessionId` | `string` | Non-empty, pattern: `conv_.*` | Session to bind to |
| `options.url` | `string` | Valid URL or 'about:blank' | Initial tab URL |

**Contract**:
- ✅ MUST call chrome.tabs.create() with provided URL
- ✅ MUST bind created tab to sessionId via bindTabToSession()
- ✅ MUST add tab to "browserx" group
- ✅ MUST return new tabId on success
- ✅ MUST return null if creation fails
- ✅ MUST complete within 500ms (SC-002 requirement)

**Preconditions**:
- `this.initialized === true`
- `sessionId` is non-empty string

**Postconditions (on success)**:
- Returns tabId > 0
- `this.getTabForSession(sessionId) === tabId`
- Tab exists in Chrome and belongs to "browserx" group

**Postconditions (on failure)**:
- Returns null
- Session remains unbound (tabId unchanged)

**Test**:
```typescript
describe('TabManager.createAndBindTab()', () => {
  it('creates tab and binds to session', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    const mockTab = { id: 789, url: 'about:blank' };
    chrome.tabs.create = vi.fn().mockResolvedValue(mockTab);

    const tabId = await manager.createAndBindTab('conv_123', { url: 'about:blank' });

    expect(tabId).toBe(789);
    expect(manager.getTabForSession('conv_123')).toBe(789);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank' });
  });

  it('returns null on creation failure', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    chrome.tabs.create = vi.fn().mockRejectedValue(new Error('Creation failed'));

    const tabId = await manager.createAndBindTab('conv_123', { url: 'about:blank' });

    expect(tabId).toBeNull();
  });
});
```

---

### onTabClosed()

```typescript
onTabClosed(callback: TabClosedCallback): void
```

**Types**:
```typescript
type TabClosedCallback = (sessionId: string, tabId: number) => void;
```

**Parameters**:

| Name | Type | Constraint | Description |
|------|------|------------|-------------|
| `callback` | `TabClosedCallback` | Function | Callback to invoke on tab closure |

**Contract**:
- ✅ MUST register callback in this.tabClosedCallbacks array
- ✅ MUST invoke callback when tab bound to sessionId is closed
- ✅ MUST pass (sessionId, tabId) to callback
- ✅ MUST handle callback errors gracefully (log, don't propagate)
- ✅ MUST support multiple registered callbacks

**Preconditions**: None

**Postconditions**:
- Callback added to internal array

**Test**:
```typescript
describe('TabManager.onTabClosed()', () => {
  it('invokes callback on tab closure', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    const callback = vi.fn();
    manager.onTabClosed(callback);

    // Simulate tab closure
    chrome.tabs.onRemoved.dispatch(456, {});

    expect(callback).toHaveBeenCalledWith('conv_123', 456);
  });
});
```

---

## Event Handling Contracts

### chrome.tabs.onRemoved Listener

**Trigger**: User closes tab or tab crashes

**Contract**:
- ✅ MUST check if tabId is bound via this.tabToSession.has(tabId)
- ✅ MUST unbind tab via this.unbindTab(tabId)
- ✅ MUST invoke all registered onTabClosed callbacks
- ✅ MUST complete within 100ms (SC-008 requirement)

**Test**:
```typescript
describe('TabManager tab closure detection', () => {
  it('handles tab removal event', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    const callback = vi.fn();
    manager.onTabClosed(callback);

    chrome.tabs.onRemoved.dispatch(456, {});

    expect(manager.getTabForSession('conv_123')).toBe(-1);
    expect(callback).toHaveBeenCalled();
  });
});
```

---

### chrome.tabs.onUpdated Listener

**Trigger**: Tab status changes (loading, unloaded, crashed)

**Contract**:
- ✅ MUST detect crashed tabs (status === 'unloaded')
- ✅ MUST treat crashed tabs same as closed tabs
- ✅ MUST unbind and notify on crash

**Test**:
```typescript
describe('TabManager crash detection', () => {
  it('handles tab crash', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();
    await manager.bindTabToSession('conv_123', 456, {});

    chrome.tabs.onUpdated.dispatch(456, { status: 'loading' }, { status: 'unloaded' });

    expect(manager.getTabForSession('conv_123')).toBe(-1);
  });
});
```

---

## Tab Group Management Contracts

### Ensure "browserx" Group Exists

**Trigger**: First call to bindTabToSession() after initialization

**Contract**:
- ✅ MUST query chrome.tabGroups.query({ title: 'browserx' })
- ✅ MUST reuse existing group if found
- ✅ MUST create new group if not found
- ✅ MUST set group title to 'browserx'
- ✅ MUST set group color to 'blue'
- ✅ MUST store groupId in this.groupId

**Test**:
```typescript
describe('TabManager group management', () => {
  it('creates browserx group on first binding', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    chrome.tabGroups.query = vi.fn().mockResolvedValue([]);
    chrome.tabGroups.group = vi.fn().mockResolvedValue(10);

    await manager.bindTabToSession('conv_123', 456, {});

    expect(chrome.tabGroups.query).toHaveBeenCalledWith({ title: 'browserx' });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(10, { title: 'browserx', color: 'blue' });
  });

  it('reuses existing browserx group', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    const existingGroup = { id: 5, title: 'browserx', color: 'blue' };
    chrome.tabGroups.query = vi.fn().mockResolvedValue([existingGroup]);

    await manager.bindTabToSession('conv_123', 456, {});

    expect(manager['groupId']).toBe(5);
  });
});
```

---

## Performance Contracts

| Operation | Max Latency | Test Approach |
|-----------|-------------|---------------|
| bindTabToSession() | 50ms (excluding Chrome API) | Mock chrome APIs, measure execution time |
| getTabForSession() | 1ms | Direct timing measurement |
| validateTab() | 100ms | End-to-end with real Chrome API |
| createAndBindTab() | 500ms | End-to-end with real Chrome API |
| Tab closure detection | 100ms | Event dispatch to callback timing |

**Performance Test Example**:
```typescript
describe('TabManager performance', () => {
  it('binds session within 50ms', async () => {
    const manager = TabManager.getInstance();
    await manager.initialize();

    const start = performance.now();
    await manager.bindTabToSession('conv_123', 456, {});
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
  });
});
```

---

## Breaking Changes from TabBindingManager

### Removed Methods

- None (all existing methods preserved for backward compatibility)

### Added Methods

- `createAndBindTab()` - New method for combined creation + binding
- Tab group management (merged from TabGroupManager)

### Behavioral Changes

| Method | Old Behavior | New Behavior |
|--------|-------------|--------------|
| `bindTabToSession()` | Only creates binding | Also adds tab to "browserx" group |
| `initialize()` | Sets up listeners only | Also queries for existing tab group |

---

## Deprecation Notice

**TabGroupManager class is DEPRECATED and will be deleted.**

Migration path:
- Replace `TabGroupManager.getInstance()` with `TabManager.getInstance()`
- Remove calls to `TabGroupManager.addTabToGroup()` (automatic in TabManager.bindTabToSession())
- Update tests to use TabManager contract tests

---

**Status**: ✅ API contract complete, ready for implementation and contract testing
