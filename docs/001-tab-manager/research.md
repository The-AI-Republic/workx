# Research: Tab Manager Refactoring

**Feature**: 001-tab-manager | **Date**: 2025-11-12 | **Phase**: 0 (Research)

## Overview

This document consolidates research findings for key technical decisions in the Tab Manager refactoring. Each decision addresses unknowns from the Technical Context and ensures alignment with Chrome Extensions API best practices, Svelte component patterns, and performance requirements.

---

## Decision 1: Service Worker Initialization Pattern

**Context**: TabManager needs to be initialized at service worker level before any agent instances are created (FR-002, FR-003).

**Decision**: Use Chrome Extension service worker global scope initialization with lazy singleton pattern

**Rationale**:
- Chrome Extension service workers persist state in memory between events but can be terminated and restarted by the browser
- Global scope initialization runs when service worker starts/restarts
- Singleton pattern ensures all extension contexts (sidepanel, content scripts, background) access the same instance
- Lazy initialization (getInstance()) provides safe access even if direct initialization fails

**Implementation approach**:
```typescript
// src/background/service-worker.ts
import { TabManager } from '../core/TabManager';

// Initialize TabManager when service worker starts
TabManager.getInstance().initialize();

// Listen for extension install/update events
chrome.runtime.onInstalled.addListener(() => {
  TabManager.getInstance().initialize();
});
```

**Alternatives considered**:
1. **Per-agent initialization** - Rejected: Violates FR-002, causes state fragmentation across multiple agent instances
2. **Chrome storage-based state** - Rejected: Adds latency (async I/O) vs in-memory (<50ms requirement for SC-009)
3. **Message-passing architecture** - Rejected: Over-engineered for single-extension scope, adds complexity

**Risks**:
- Service worker termination loses in-memory state → Mitigated by persisting critical tabId in SessionState
- Race conditions during initialization → Mitigated by promise-based initialize() with idempotency check

---

## Decision 2: TabGroupManager Merger Strategy

**Context**: Need to merge 360 lines from TabGroupManager.ts into TabManager (FR-009, FR-010) while maintaining testability.

**Decision**: Inline tab grouping methods into TabManager class with private helper methods

**Rationale**:
- TabGroupManager operations are always triggered by tab binding events → Natural coupling with TabManager
- Eliminates circular dependency risk (TabManager → TabGroupManager → chrome.tabs)
- Reduces cognitive load (single source of truth for tab operations)
- Maintains encapsulation through private methods (e.g., `private ensureTabInNormalWindow()`)

**Implementation approach**:
1. Copy TabGroupManager methods as private methods in TabManager:
   - `initializeGroup()` → `private async ensureBrowserXGroup(): Promise<number | null>`
   - `addTabToGroup()` → integrated into `bindTabToSession()`
   - `createGroup()` → `private async createBrowserXGroup(tabId: number): Promise<void>`
2. Add group state to TabManager: `private groupId: number | null = null`
3. Update `bindTabToSession()` to call group operations automatically
4. Delete src/tools/tab/TabGroupManager.ts

**Alternatives considered**:
1. **Composition (TabManager uses TabGroupManager)** - Rejected: Adds layer of indirection, doesn't reduce line count
2. **Keep separate, add facade** - Rejected: Violates FR-010, maintains duplication
3. **Extract shared interface** - Rejected: Over-engineered for single implementation

**Migration path**:
1. Merge code → Run tests → Fix failures
2. Update all TabGroupManager imports to TabManager
3. Delete TabGroupManager.ts and tests
4. Consolidate test coverage in TabManager.test.ts

---

## Decision 3: Active Tab Detection Strategy

**Context**: Sessions need to automatically bind to the active tab on creation (FR-004, FR-005, User Story 1).

**Decision**: Use `chrome.tabs.query({ active: true, currentWindow: true })` at session creation time

**Rationale**:
- `active: true` filter ensures only one tab per window (matches user expectation)
- `currentWindow: true` prioritizes the focused window (aligns with User Story 1, scenario 3)
- Synchronous call from Session constructor works because TabManager is already initialized
- Graceful fallback to tabId = -1 if query returns empty (FR-006)

**Implementation approach**:
```typescript
// src/core/Session.ts (constructor)
constructor(...) {
  // ... existing initialization ...

  // NEW: Attempt to bind to active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (activeTab?.id) {
      TabManager.getInstance().bindTabToSession(this.conversationId, activeTab.id, {
        title: activeTab.title || '',
        url: activeTab.url || ''
      });
      this.sessionState.setTabId(activeTab.id);
    } else {
      this.sessionState.setTabId(-1); // No active tab available
    }
  });
}
```

**Alternatives considered**:
1. **Use chrome.windows.getCurrent() + chrome.tabs.query()** - Rejected: Two API calls add latency, violates SC-001 (<100ms)
2. **Listen to chrome.tabs.onActivated** - Rejected: Event-driven approach complex for initialization
3. **User-prompted tab selection** - Rejected: Violates FR-004/FR-005 (must be automatic)

**Edge cases handled**:
- Multiple windows: `currentWindow: true` ensures focused window priority
- No tabs: Query returns empty array → tabId = -1
- Permission-restricted tabs: Binding succeeds but operations may fail → Error handling in TabTool

---

## Decision 4: Tab Creation Timing and Mechanism

**Context**: When user sends message with tabId = -1, need to create tab before agent processing (FR-007, FR-007a, User Story 2).

**Decision**: Hook into message submission flow with async tab creation gate before TurnContext execution

**Rationale**:
- Message submission is the trigger point (user action)
- Async/await pattern allows waiting for tab creation without blocking UI
- Creating tab in TabManager keeps logic centralized
- about:blank URL (FR-007a clarification) prevents unintended navigation

**Implementation approach**:
```typescript
// src/core/BrowserxAgent.ts or Session.ts (submitMessage handler)
async submitMessage(message: string) {
  const currentTabId = this.session.getTabId();

  if (currentTabId === -1) {
    // Create new tab via TabManager
    const newTabId = await TabManager.getInstance().createAndBindTab(
      this.session.getId(),
      { url: 'about:blank' }
    );

    if (!newTabId) {
      throw new Error('Failed to create tab for session');
    }
  }

  // Proceed with agent processing...
}
```

**Alternatives considered**:
1. **Create tab in TurnContext** - Rejected: Violates separation of concerns (context shouldn't manage tabs)
2. **Create tab in TabTool** - Rejected: FR-023 excludes TabTool from LLM, so not called
3. **Lazy creation on first tool use** - Rejected: Violates FR-007 (must create BEFORE processing)

**Performance target**: SC-002 requires <500ms for creation + binding. Chrome tab creation typically <200ms, binding <50ms → 250ms total, well under budget.

---

## Decision 5: TabContext Dropdown UI Pattern

**Context**: TabContext needs clickable interaction with dropdown menu (FR-017, FR-018, User Story 3).

**Decision**: Use Svelte reactive store + conditional rendering with click-outside detection

**Rationale**:
- Svelte's reactive stores provide clean state management
- Conditional rendering (`{#if showDropdown}`) is idiomatic Svelte
- Click-outside detection via document event listener (FR-022a clarification)
- Dropdown positioned absolutely relative to TabContext container

**Implementation approach**:
```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  let showDropdown = false;
  let allTabs: chrome.tabs.Tab[] = [];
  let dropdownRef: HTMLElement;

  async function handleClick() {
    if (!showDropdown) {
      // Fetch all tabs
      allTabs = await chrome.tabs.query({});
      showDropdown = true;
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
      showDropdown = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
  });
</script>

<div class="tab-context" on:click={handleClick}>
  {displayTitle}
</div>

{#if showDropdown}
  <div class="dropdown" bind:this={dropdownRef}>
    <div class="dropdown-item" on:click={() => selectNewTab()}>
      + New Tab
    </div>
    {#each allTabs as tab}
      <div class="dropdown-item" on:click={() => selectTab(tab.id)}>
        {tab.title}
      </div>
    {/each}
  </div>
{/if}
```

**Alternatives considered**:
1. **HTML <select> element** - Rejected: Limited styling, can't show window grouping
2. **Third-party dropdown library** - Rejected: Adds dependency, overkill for simple UI
3. **Modal dialog** - Rejected: Heavier UX than inline dropdown

**Accessibility**: Add keyboard navigation (arrow keys, Enter, Escape) in future iteration (out of current scope per spec).

---

## Decision 6: MessageInput Component Extraction

**Context**: Extract textarea into MessageInput.svelte containing TabContext (FR-014, FR-015, User Story 6).

**Decision**: Create MessageInput.svelte with props-based API, slot for TabContext integration

**Rationale**:
- Props-based API (`value`, `onSubmit`) maintains simplicity
- Slot pattern allows flexible TabContext positioning
- Component can be tested in isolation (User Story 6 independent test requirement)
- Minimal changes to parent App.svelte

**Implementation approach**:
```svelte
<!-- src/sidepanel/components/MessageInput.svelte -->
<script lang="ts">
  export let value: string = '';
  export let onSubmit: (value: string) => void;
  export let tabId: number = -1;

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit(value);
    }
  }
</script>

<div class="message-input-container">
  <TabContext {tabId} />
  <textarea
    bind:value
    on:keypress={handleKeyPress}
    placeholder="Type a message..."
  />
</div>

<!-- Usage in App.svelte -->
<MessageInput
  bind:value={inputValue}
  onSubmit={handleSubmit}
  tabId={session.getTabId()}
/>
```

**Alternatives considered**:
1. **Keep TerminalInput, nest MessageInput** - Rejected: Confusing naming, adds layer
2. **Merge TabContext into MessageInput template** - Rejected: Violates FR-015 (must CONTAIN, not merge)
3. **Use Svelte stores for communication** - Rejected: Props simpler for parent-child data flow

**Migration**: TerminalInput.svelte remains for backward compatibility but redirects to MessageInput.svelte internally.

---

## Decision 7: TabTool Conditional Registration

**Context**: Must NOT expose TabTool to LLM (FR-023, SC-007) but keep code for potential future use.

**Decision**: Add feature flag check in ToolRegistry during tool registration

**Rationale**:
- Keeps TabTool code in codebase (easier to re-enable than rewrite)
- ToolRegistry already controls tool availability to LLM
- Single-line config change to re-enable if requirements change
- Zero performance impact (compile-time exclusion)

**Implementation approach**:
```typescript
// src/tools/index.ts (registerTools function)
export async function registerTools(registry: ToolRegistry, config: IToolsConfig) {
  // ... register other tools ...

  // FR-023: Do NOT expose TabTool to LLM (agent manages tabs automatically)
  // registry.register(new TabTool()); // COMMENTED OUT

  // ... continue with other tools ...
}
```

**Alternatives considered**:
1. **Delete TabTool entirely** - Rejected: May be useful for future manual control scenarios
2. **Runtime feature flag** - Rejected: Adds config complexity, unnecessary for this requirement
3. **Separate "admin tools" registry** - Rejected: Over-engineered for single tool exclusion

**Verification**: SC-007 test checks `registry.listTools()` output excludes TabTool.

---

## Decision 8: Last-Write-Wins Conflict Resolution

**Context**: Multiple sessions binding to same tab requires conflict resolution (FR-025, SC-009).

**Decision**: Implement synchronous last-write-wins in TabManager.bindTabToSession() with notification callback

**Rationale**:
- Last-write-wins is simplest conflict resolution (no locks, no queues)
- Synchronous resolution ensures SC-009 (<50ms) performance target
- Notification callback allows previous session to update UI gracefully
- Matches existing TabBindingManager pattern (proven in production)

**Implementation approach**:
```typescript
// src/core/TabManager.ts
async bindTabToSession(sessionId: string, tabId: number, tabInfo: TabInfo): Promise<void> {
  const existingSessionId = this.tabToSession.get(tabId);

  if (existingSessionId && existingSessionId !== sessionId) {
    // Last-write-wins: unbind previous session
    this.sessionToTab.delete(existingSessionId);

    // Notify previous session (triggers UI update)
    this.notifyTabClosed(existingSessionId, tabId);

    // Set previous session's tabId to -1 (FR-024a clarification)
    // Done via notifyTabClosed callback in BrowserAgent
  }

  // Establish new binding
  this.tabToSession.set(tabId, sessionId);
  this.sessionToTab.set(sessionId, tabId);
}
```

**Alternatives considered**:
1. **First-write-wins (lock tab)** - Rejected: User can't override stuck binding
2. **User prompt for conflict** - Rejected: Adds friction, violates SC-009 (<50ms)
3. **Queue-based assignment** - Rejected: Complex, delays binding, unnecessary

**Edge case**: Session A bound to tab 123 → Session B binds to tab 123 → Session A's tabId becomes -1 → User must explicitly rebind Session A (FR-024a).

---

## Technology Stack Summary

| Component | Technology | Version | Justification |
|-----------|-----------|---------|---------------|
| Language | TypeScript | 5.9+ | Type safety, existing codebase standard |
| UI Framework | Svelte | 4.2 | Existing framework, reactive patterns |
| Build Tool | Vite | 5.4 | Fast HMR, Chrome Extension support |
| Testing | Vitest | 3.2 | Unified test runner (unit + integration) |
| Component Tests | @testing-library/svelte | 5.2 | User-centric testing, Svelte support |
| Chrome API Mocking | chrome-mock | 0.0.9 | Test isolation for Extension APIs |
| Target Platform | Chrome Extensions | Manifest V3 | Declared in manifest.json |

**No new dependencies required** - All technologies already in package.json.

---

## Performance Budget Validation

| Requirement | Target | Implementation Strategy | Expected Result |
|-------------|--------|------------------------|-----------------|
| SC-001: Session binding | <100ms | chrome.tabs.query (typically 20-40ms) + in-memory map update (<1ms) | ✅ ~50ms |
| SC-002: Tab creation | <500ms | chrome.tabs.create (150-200ms) + bindTabToSession (50ms) + group add (100ms) | ✅ ~350ms |
| SC-006: Dropdown render | <200ms | chrome.tabs.query all tabs (50-80ms for <100 tabs) + Svelte render (10ms) | ✅ ~100ms |
| SC-008: Tab closure detection | <100ms | chrome.tabs.onRemoved listener (event-driven, <10ms) | ✅ ~10ms |
| SC-009: Conflict resolution | <50ms | In-memory map operations (synchronous, <1ms) | ✅ ~5ms |

**Conclusion**: All performance targets achievable with proposed implementations. No optimization strategies needed beyond straightforward implementation.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Service worker termination clears TabManager state | High | Persist tabId in SessionState (already exists), reinitialize TabManager on restart |
| Race condition: Session creation + active tab query | Medium | Use callback pattern in chrome.tabs.query, default to -1 on timeout |
| Tab group API unavailable in some Chromium browsers | Low | Graceful degradation: Skip grouping if chrome.tabGroups undefined |
| Dropdown menu overflows viewport | Low | CSS max-height + scroll, position: fixed fallback |
| TabGroupManager migration breaks existing tests | Medium | Run full test suite after merge, update test expectations |
| Chrome Extensions API permission denial | High | Check manifest.json permissions (tabs, tabGroups), document required permissions |

---

## Open Questions (Resolved via Clarification)

All potential ambiguities were resolved in `/speckit.clarify`:
1. ✅ New tab URL → about:blank (FR-007a)
2. ✅ Dropdown dismiss behavior → Close without changes (FR-022a)
3. ✅ Rebinding after tab loss → No automatic rebinding (FR-024a)

**No remaining unknowns** - Implementation can proceed to Phase 1 (Design).

---

## References

- [Chrome Extensions API: chrome.tabs](https://developer.chrome.com/docs/extensions/reference/tabs/)
- [Chrome Extensions API: chrome.tabGroups](https://developer.chrome.com/docs/extensions/reference/tabGroups/)
- [Svelte Component Lifecycle](https://svelte.dev/docs/svelte-components#script)
- [Vitest Testing Framework](https://vitest.dev/)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

**Status**: ✅ Research complete, ready for Phase 1 (Design & Contracts)
