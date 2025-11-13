# Data Model: Tab Manager Refactoring

**Feature**: 001-tab-manager | **Date**: 2025-11-12 | **Phase**: 1 (Design)

## Overview

This document defines the data structures, relationships, validation rules, and state transitions for the Tab Manager refactoring. The model focuses on the core entities: TabManager, Session, TabBinding, TabGroup, and UI components (MessageInput, TabContext).

---

## Entity Definitions

### TabManager (Singleton)

**Purpose**: Central manager for all tab lifecycle operations, binding management, and tab group coordination.

**Attributes**:

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `tabToSession` | `Map<number, string>` | Private | Maps tabId → sessionId (fast lookup) |
| `sessionToTab` | `Map<string, number>` | Private | Maps sessionId → tabId (reverse lookup) |
| `bindings` | `Map<number, TabBindingState>` | Private | Maps tabId → full binding metadata |
| `groupId` | `number \| null` | Private | Current "browserx" tab group ID (null if not created) |
| `tabClosedCallbacks` | `TabClosedCallback[]` | Private | Registered listeners for tab closure events |
| `initialized` | `boolean` | Private | Tracks initialization state |
| `initializationPromise` | `Promise<void> \| null` | Private | Prevents concurrent initialization |

**Validation Rules**:
- `tabToSession` and `sessionToTab` must be kept in sync (bidirectional consistency)
- `groupId` must be valid chrome.tabGroups.TabGroup.id or null
- `initialized` must be true before any binding operations

**State Transitions**:
```
[Uninitialized] --initialize()--> [Initialized]
[Initialized] --bindTabToSession()--> [Binding Active]
[Binding Active] --unbindTab()--> [Initialized]
[Initialized] --service worker restart--> [Uninitialized] (memory cleared)
```

**Methods (Public API)**:
- `getInstance(): TabManager` - Singleton accessor
- `initialize(): Promise<void>` - Initialize manager and tab group
- `bindTabToSession(sessionId: string, tabId: number, tabInfo: TabInfo): Promise<void>` - Create binding
- `unbindTab(tabId: number): void` - Remove tab binding
- `unbindSession(sessionId: string): void` - Remove session binding
- `getSessionForTab(tabId: number): string | undefined` - Lookup sessionId by tabId
- `getTabForSession(sessionId: string): number` - Lookup tabId by sessionId (returns -1 if unbound)
- `getBinding(tabId: number): TabBindingState | undefined` - Get full binding info
- `validateTab(tabId: number): Promise<TabValidationState>` - Check tab existence
- `createAndBindTab(sessionId: string, options: {url: string}): Promise<number | null>` - Create + bind new tab
- `onTabClosed(callback: TabClosedCallback): void` - Register closure listener

---

### TabBindingState

**Purpose**: Metadata for active tab-to-session binding.

**Attributes**:

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `tabId` | `number` | Required, >0 | Chrome tab ID |
| `sessionId` | `string` | Required, non-empty | Session conversation ID |
| `boundAt` | `number` | Required, timestamp | Unix timestamp (ms) when binding created |
| `tabTitle` | `string` | Required | Tab title at binding time (may be empty string) |
| `tabUrl` | `string` | Required | Tab URL at binding time (may be empty string) |

**Validation Rules**:
- `tabId` must be positive integer
- `sessionId` must match pattern `conv_[uuid]`
- `boundAt` must be valid timestamp (Date.now())
- `tabTitle` and `tabUrl` capture point-in-time values (not reactively updated)

**Lifecycle**: Created in `bindTabToSession()`, deleted in `unbindTab()` or `unbindSession()`

---

### Session (Partial - Additions Only)

**Purpose**: Represents agent conversation session. This section documents ONLY new/modified fields related to tab management.

**New/Modified Attributes**:

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `sessionState.tabId` | `number` | Required, default -1 | Bound tab ID (-1 = no tab, >0 = valid tab) |

**Validation Rules**:
- `tabId === -1` indicates no tab bound (initial state or after tab closure)
- `tabId > 0` must correspond to valid Chrome tab (verified via TabManager.validateTab())

**State Transitions**:
```
[Session Created] --active tab exists--> [tabId = active tab ID]
[Session Created] --no active tab--> [tabId = -1]
[tabId > 0] --tab closed--> [tabId = -1]
[tabId > 0] --binding lost to another session--> [tabId = -1]
[tabId = -1] --user sends message--> [create new tab] --> [tabId = new tab ID]
[tabId = -1] --user selects tab--> [tabId = selected tab ID]
```

**New Behavior**:
- Session constructor attempts `chrome.tabs.query({active: true, currentWindow: true})` and binds if tab found (FR-004, FR-005)
- Session.submitMessage() checks `tabId === -1` and calls TabManager.createAndBindTab() before processing (FR-007)

---

### TabInfo (Helper Type)

**Purpose**: Simplified tab metadata for binding operations.

**Attributes**:

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `title` | `string` | Optional, default '' | Tab title |
| `url` | `string` | Optional, default '' | Tab URL |

**Usage**: Passed to `TabManager.bindTabToSession()` to populate `TabBindingState`

---

### TabValidationState (Union Type)

**Purpose**: Result of tab existence validation.

**Valid State**:
```typescript
{
  status: 'valid';
  tab: chrome.tabs.Tab;
}
```

**Invalid State**:
```typescript
{
  status: 'invalid';
  reason: TabInvalidReason;
}
```

**TabInvalidReason Enum**:
- `NOT_FOUND` - Tab does not exist (closed or never existed)
- `CLOSED` - Tab was explicitly closed
- `PERMISSION_DENIED` - Extension lacks permission to access tab

**Validation Rules**:
- Must return within 100ms (chrome.tabs.get timeout)
- `tabId === -1` always returns `{status: 'invalid', reason: NOT_FOUND}`

---

### TabGroup (Chrome API Wrapper)

**Purpose**: Represents "browserx" tab group managed by TabManager.

**Attributes** (from chrome.tabGroups.TabGroup):

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `id` | `number` | Required, >0 | Group ID |
| `title` | `string` | Required, = 'browserx' | Group title (constant) |
| `color` | `chrome.tabGroups.ColorEnum` | Required, = 'blue' | Group color (constant) |
| `collapsed` | `boolean` | Optional, default false | Group collapse state |
| `windowId` | `number` | Required, >0 | Window containing group |

**Validation Rules**:
- Only ONE "browserx" group exists per window
- TabManager.groupId tracks current group ID (null if not created)
- Group is created on first tab binding (FR-013) or reused if exists (FR-012)

**State Transitions**:
```
[No Group] --first tab binding--> [Group Created (id = X, title = 'browserx', color = 'blue')]
[Group Exists] --tab binding--> [Tab Added to Group]
[Group Exists] --user deletes group--> [No Group] --> [recreate on next binding]
[Group Exists] --browser restart--> [Group Persists (reused)]
```

---

## UI Component Data Models

### MessageInput.svelte Props

**Purpose**: Props interface for MessageInput component.

**Attributes**:

| Prop | Type | Constraint | Description |
|------|------|------------|-------------|
| `value` | `string` | Required, bind:value | Current input text |
| `onSubmit` | `(value: string) => void` | Required | Callback when user submits (Enter key) |
| `tabId` | `number` | Required | Current session's tabId (passed to TabContext) |
| `placeholder` | `string` | Optional, default 'Type a message...' | Input placeholder text |

**Validation Rules**:
- `value` can be empty string
- `onSubmit` must be callable function
- `tabId` passed through to TabContext without validation

**Events**:
- `keypress` - Handles Enter key to trigger onSubmit

---

### TabContext.svelte Props

**Purpose**: Props interface for TabContext component (enhanced with dropdown).

**Attributes**:

| Prop | Type | Constraint | Description |
|------|------|------------|-------------|
| `tabId` | `number` | Required | Current session's tabId (-1 = no tab) |

**Internal State**:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `showDropdown` | `boolean` | false | Dropdown menu visibility |
| `allTabs` | `chrome.tabs.Tab[]` | [] | All browser tabs (fetched on click) |
| `tabTitle` | `string` | '' | Resolved tab title for display |
| `fullTitle` | `string` | '' | Full title for tooltip |
| `displayTitle` | `string` | '' | Truncated title (max 25 chars) |
| `isLoading` | `boolean` | false | Loading state during tab fetch |
| `error` | `string \| null` | null | Error message if tab fetch fails |

**Validation Rules**:
- `tabId === -1` → display "No tab attached"
- `tabId > 0` → fetch tab via `chrome.tabs.get()`, display title
- `displayTitle` truncated to 25 characters with ellipsis if longer
- Dropdown renders only if `showDropdown === true`

**Events**:
- `click` on TabContext → Toggle showDropdown, fetch all tabs
- `click` outside dropdown → Set showDropdown = false (FR-022a)
- `click` on dropdown item → Update session tabId, close dropdown

---

## Relationships

### TabManager ↔ Session

- **1-to-N**: One TabManager instance serves multiple Session instances
- **Binding**: TabManager.bindTabToSession(sessionId, tabId) creates TabBindingState
- **Lookup**: Session calls TabManager.getTabForSession(sessionId) to get current tabId
- **Notification**: TabManager.onTabClosed() callback notifies Session when tab closed

### TabManager ↔ Chrome Tab

- **1-to-1**: Each TabBindingState.tabId maps to unique chrome.tabs.Tab
- **Lifecycle**: TabManager listens to chrome.tabs.onRemoved and chrome.tabs.onUpdated
- **Creation**: TabManager.createAndBindTab() calls chrome.tabs.create() and binds result

### TabManager ↔ TabGroup

- **1-to-1**: TabManager.groupId references single "browserx" chrome.tabGroups.TabGroup
- **Lazy Init**: Group created on first bindTabToSession() if groupId === null
- **Reuse**: TabManager.initialize() queries chrome.tabGroups.query({title: 'browserx'}) to reuse existing group

### Session ↔ TabContext (UI)

- **1-to-1**: Each Session rendered in UI has one TabContext component
- **Data Flow**: Session.tabId prop → TabContext.tabId
- **Callback**: TabContext tab selection → Session.setTabId() → TabManager.bindTabToSession()

### MessageInput ↔ TabContext (UI)

- **1-to-1**: MessageInput contains one TabContext component
- **Composition**: TabContext rendered inside MessageInput template
- **Data Flow**: MessageInput.tabId prop → TabContext.tabId prop

---

## Data Flow Diagrams

### Session Creation Flow

```
User creates session
        ↓
Session constructor
        ↓
chrome.tabs.query({active: true, currentWindow: true})
        ↓
  [Has active tab?]
    /           \
  YES            NO
   ↓              ↓
TabManager.bindTabToSession(sessionId, activeTabId)    sessionState.setTabId(-1)
   ↓                                                     ↓
sessionState.setTabId(activeTabId)                   [Session with tabId = -1]
   ↓
[Session bound to active tab]
```

### Message Submission with tabId = -1 Flow

```
User submits message (tabId = -1)
        ↓
Session.submitMessage()
        ↓
Check sessionState.tabId
        ↓
   [tabId === -1?]
    /           \
  YES            NO
   ↓              ↓
TabManager.createAndBindTab(sessionId, {url: 'about:blank'})    Proceed to agent processing
   ↓
chrome.tabs.create({url: 'about:blank'})
   ↓
chrome.tabGroups.group({tabIds: newTabId, groupId: TabManager.groupId})
   ↓
TabManager.bindTabToSession(sessionId, newTabId)
   ↓
sessionState.setTabId(newTabId)
   ↓
[Continue to agent processing with valid tabId]
```

### Manual Tab Selection Flow

```
User clicks TabContext
        ↓
showDropdown = true
        ↓
chrome.tabs.query({}) → allTabs
        ↓
Render dropdown menu
        ↓
User clicks tab item (or "New Tab")
        ↓
  [Selected "New Tab"?]
    /           \
  YES            NO
   ↓              ↓
sessionState.setTabId(-1)    TabManager.bindTabToSession(sessionId, selectedTabId)
   ↓                          ↓
[tabId = -1, will create     sessionState.setTabId(selectedTabId)
 on next message]             ↓
                           [Session bound to selected tab]
        ↓
showDropdown = false
```

### Tab Closure Detection Flow

```
User closes tab
        ↓
chrome.tabs.onRemoved event
        ↓
TabManager.handleTabRemoved(tabId)
        ↓
  [tabId in tabToSession?]
    /           \
  YES            NO
   ↓              ↓
Get sessionId    Ignore (not bound)
   ↓
TabManager.unbindTab(tabId)
   ↓
TabManager.notifyTabClosed(sessionId, tabId)
   ↓
Session callback: sessionState.setTabId(-1)
   ↓
[Session tabId reset to -1, user must rebind]
```

### Last-Write-Wins Conflict Flow

```
Session A bound to tab 123
        ↓
Session B calls TabManager.bindTabToSession(sessionB.id, 123)
        ↓
TabManager detects existing binding (sessionA → 123)
        ↓
TabManager.unbindSession(sessionA.id)
        ↓
TabManager.notifyTabClosed(sessionA.id, 123)
        ↓
Session A callback: sessionState.setTabId(-1)
        ↓
TabManager.bindTabToSession(sessionB.id, 123)
        ↓
Session B callback: sessionState.setTabId(123)
        ↓
[Session B owns tab 123, Session A has tabId = -1]
```

---

## Persistence Strategy

### In-Memory State (TabManager)

**Persisted in**: Service worker memory (volatile)

**Loss condition**: Service worker termination/restart

**Recovery strategy**:
- TabManager.initialize() on service worker start
- Reuse existing "browserx" tab group (chrome.tabGroups.query)
- Sessions retain their tabId in SessionState (persisted separately)

### Persistent State (SessionState)

**Persisted in**: Chrome Extension storage (existing mechanism)

**Fields**:
- `sessionState.tabId` → Stored with session data

**Recovery strategy**:
- On session restoration, tabId loaded from storage
- If tabId > 0, validate via TabManager.validateTab()
- If tab invalid (closed), reset tabId to -1

### Non-Persistent State

**Not persisted**:
- TabBindingState.boundAt (timestamp) - Recalculated on rebinding
- TabBindingState.tabTitle/tabUrl - Refetched on demand
- TabContext.showDropdown - Always starts false

---

## Validation Invariants

### Global Invariants (Must Hold Always)

1. **Bidirectional Consistency**: `∀ tabId ∈ tabToSession.keys() → sessionToTab.get(tabToSession.get(tabId)) === tabId`
2. **Binding Completeness**: `∀ tabId ∈ bindings.keys() → tabId ∈ tabToSession.keys()`
3. **Tab Uniqueness**: `∀ sessionId1, sessionId2 ∈ sessionToTab.keys() → sessionToTab.get(sessionId1) !== sessionToTab.get(sessionId2)`
4. **Group Singularity**: At most one "browserx" tab group exists per browser window

### Method Preconditions

| Method | Precondition |
|--------|--------------|
| `bindTabToSession()` | TabManager.initialized === true |
| `createAndBindTab()` | TabManager.initialized === true, sessionId not already bound |
| `validateTab()` | tabId is number (no initialization required) |
| `getTabForSession()` | sessionId is non-empty string |

### Method Postconditions

| Method | Postcondition |
|--------|---------------|
| `bindTabToSession()` | tabToSession.get(tabId) === sessionId AND sessionToTab.get(sessionId) === tabId |
| `unbindTab()` | !tabToSession.has(tabId) AND !bindings.has(tabId) |
| `createAndBindTab()` | Returns tabId > 0 OR null (failure) |

---

## Error Handling

### TabManager Errors

| Error Scenario | Error Type | Handling |
|----------------|-----------|----------|
| Tab creation fails | `TabCreationError` | Return null from createAndBindTab(), session shows error to user |
| Tab validation fails | `TabValidationError` | Return {status: 'invalid', reason: NOT_FOUND/PERMISSION_DENIED} |
| Group creation fails | `TabGroupError` | Log warning, continue without grouping (graceful degradation) |
| Initialization fails | `InitializationError` | Log error, retry on next getInstance() call |

### UI Component Errors

| Error Scenario | Display Behavior |
|----------------|------------------|
| TabContext: Tab fetch fails | Display "Tab unavailable" in red text |
| TabContext: Dropdown fetch fails | Show error message in dropdown, allow retry |
| MessageInput: Submit with invalid tabId | Prevent submission, show error notification |

---

## Migration from TabBindingManager to TabManager

### Data Structure Changes

| Old (TabBindingManager) | New (TabManager) | Notes |
|-------------------------|------------------|-------|
| `tabToSession` | `tabToSession` | No change |
| `sessionToTab` | `sessionToTab` | No change |
| `bindings` | `bindings` | No change |
| N/A | `groupId` | New field (merged from TabGroupManager) |
| N/A | `initializationPromise` | New field (prevents concurrent init) |

### Method Signature Changes

| Old Method | New Method | Changes |
|-----------|-----------|---------|
| `initialize()` | `initialize()` | Now also initializes tab group |
| `bindTabToSession()` | `bindTabToSession()` | Now also adds tab to group |
| N/A | `createAndBindTab()` | New method (combines creation + binding) |

---

## Performance Characteristics

| Operation | Complexity | Expected Latency |
|-----------|-----------|------------------|
| TabManager.bindTabToSession() | O(1) | <10ms (map operations) |
| TabManager.getTabForSession() | O(1) | <1ms (map lookup) |
| TabManager.validateTab() | O(1) | 20-40ms (Chrome API call) |
| TabManager.createAndBindTab() | O(1) | 200-350ms (tab creation + binding + grouping) |
| TabContext dropdown render | O(n) where n = tab count | 50-100ms for 50-100 tabs |

---

**Status**: ✅ Data model complete, ready for contract definitions (Phase 1 cont.)
