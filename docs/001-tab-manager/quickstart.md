# Quickstart Guide: Tab Manager Refactoring

**Feature**: 001-tab-manager | **Date**: 2025-11-12 | **For**: Developers implementing this feature

## Overview

This guide provides a quick start for implementing the Tab Manager refactoring. Follow the steps in order for a systematic approach that minimizes integration issues.

---

## Prerequisites

Before starting implementation:

1. ✅ Read [spec.md](./spec.md) - Understand user stories and requirements
2. ✅ Read [research.md](./research.md) - Understand technical decisions
3. ✅ Read [data-model.md](./data-model.md) - Understand data structures
4. ✅ Read [contracts/tab-manager-api.md](./contracts/tab-manager-api.md) - Understand API contracts
5. ✅ Ensure dev environment set up:
   ```bash
   npm install
   npm run type-check  # Should pass
   npm test            # Should pass
   ```

---

## Implementation Phases

### Phase 1: Rename TabBindingManager → TabManager (Foundation)

**Goal**: Establish the renamed TabManager class as the foundation without adding new functionality yet.

**Steps**:

1. **Rename the file**:
   ```bash
   git mv src/core/TabBindingManager.ts src/core/TabManager.ts
   ```

2. **Update class name**:
   ```typescript
   // src/core/TabManager.ts
   export class TabManager {  // was: TabBindingManager
     private static instance: TabManager | null = null;
     // ... rest unchanged for now
   }
   ```

3. **Update all imports** across codebase:
   ```bash
   # Find all files importing TabBindingManager
   grep -r "TabBindingManager" src/ tests/

   # Update each file:
   # - import { TabBindingManager } from → import { TabManager } from
   # - TabBindingManager.getInstance() → TabManager.getInstance()
   ```

4. **Update type references**:
   ```typescript
   // src/types/session.ts
   // No changes needed - types remain the same
   ```

5. **Rename test file**:
   ```bash
   git mv tests/unit/TabBindingManager.test.ts tests/unit/TabManager.test.ts
   ```

6. **Update test imports and references**:
   ```typescript
   // tests/unit/TabManager.test.ts
   import { TabManager } from '@/core/TabManager';

   describe('TabManager', () => {
     it('returns singleton instance', () => {
       const instance1 = TabManager.getInstance();
       const instance2 = TabManager.getInstance();
       expect(instance1).toBe(instance2);
     });
   });
   ```

7. **Verify**:
   ```bash
   npm run type-check  # Should pass
   npm test            # All tests should pass
   ```

**Deliverable**: TabManager class with identical functionality to TabBindingManager, all tests passing.

---

### Phase 2: Merge TabGroupManager into TabManager

**Goal**: Consolidate tab grouping logic into TabManager, eliminating duplication.

**Steps**:

1. **Copy TabGroupManager fields to TabManager**:
   ```typescript
   // src/core/TabManager.ts
   export class TabManager {
     // ... existing fields ...

     // NEW: Merged from TabGroupManager
     private groupId: number | null = null;
     private readonly groupTitle = 'browserx';
     private readonly groupColor: chrome.tabGroups.ColorEnum = 'blue';
   }
   ```

2. **Copy helper methods as private methods**:
   ```typescript
   // src/core/TabManager.ts
   export class TabManager {
     // ... existing methods ...

     // NEW: Merged from TabGroupManager
     private async ensureBrowserXGroup(): Promise<number | null> {
       // ... implementation from TabGroupManager.initialize() ...
     }

     private async createBrowserXGroup(tabId: number): Promise<void> {
       // ... implementation from TabGroupManager.createGroup() ...
     }

     private async isTabInNormalWindow(tab: chrome.tabs.Tab): Promise<boolean> {
       // ... implementation from TabGroupManager ...
     }

     private async ensureTabInNormalWindow(
       tab: chrome.tabs.Tab,
       targetWindowId?: number
     ): Promise<chrome.tabs.Tab | null> {
       // ... implementation from TabGroupManager ...
     }
   }
   ```

3. **Update initialize() to set up group**:
   ```typescript
   // src/core/TabManager.ts
   async initialize(): Promise<void> {
     if (this.initialized) {
       return;
     }

     // Existing listener setup...
     chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
     chrome.tabs.onUpdated.addListener(this.handleTabUpdated.bind(this));

     // NEW: Initialize tab group
     await this.ensureBrowserXGroup();

     this.initialized = true;
   }
   ```

4. **Update bindTabToSession() to add tab to group**:
   ```typescript
   // src/core/TabManager.ts
   async bindTabToSession(sessionId: string, tabId: number, tabInfo: TabInfo): Promise<void> {
     // ... existing binding logic ...

     // NEW: Add tab to group
     if (this.groupId !== null) {
       try {
         await chrome.tabs.group({
           tabIds: tabId,
           groupId: this.groupId,
         });
       } catch (error) {
         console.error('Failed to add tab to group:', error);
         // Continue without grouping (graceful degradation)
       }
     } else {
       // Create group if doesn't exist
       await this.createBrowserXGroup(tabId);
     }
   }
   ```

5. **Update tests to include grouping verification**:
   ```typescript
   // tests/unit/TabManager.test.ts
   describe('TabManager grouping', () => {
     it('adds tab to browserx group on binding', async () => {
       const manager = TabManager.getInstance();
       await manager.initialize();

       await manager.bindTabToSession('conv_123', 456, {});

       expect(chrome.tabs.group).toHaveBeenCalledWith({
         tabIds: 456,
         groupId: manager['groupId'],
       });
     });
   });
   ```

6. **Remove TabGroupManager references**:
   ```bash
   # Find all usages of TabGroupManager
   grep -r "TabGroupManager" src/ tests/

   # Replace with TabManager calls or remove if now redundant
   ```

7. **Delete TabGroupManager files**:
   ```bash
   git rm src/tools/tab/TabGroupManager.ts
   git rm tests/unit/TabGroupManager.test.ts
   ```

8. **Verify**:
   ```bash
   npm run type-check
   npm test
   ```

**Deliverable**: TabManager with integrated grouping, TabGroupManager deleted, all tests passing.

---

### Phase 3: Service Worker Initialization

**Goal**: Initialize TabManager at service worker level before any agent instances.

**Steps**:

1. **Update service worker**:
   ```typescript
   // src/background/service-worker.ts
   import { TabManager } from '../core/TabManager';

   // Initialize TabManager on service worker start
   (async () => {
     await TabManager.getInstance().initialize();
     console.log('[ServiceWorker] TabManager initialized');
   })();

   // Re-initialize on extension install/update
   chrome.runtime.onInstalled.addListener(async () => {
     await TabManager.getInstance().initialize();
   });
   ```

2. **Remove TabManager initialization from BrowserxAgent**:
   ```typescript
   // src/core/BrowserxAgent.ts
   async initialize(): Promise<void> {
     // ... existing initialization ...

     // REMOVE: TabManager initialization (now in service worker)
     // const tabBindingManager = TabBindingManager.getInstance();
     // await tabBindingManager.initialize();

     // ... rest of initialization ...
   }
   ```

3. **Update agent to use TabManager** (already available):
   ```typescript
   // src/core/BrowserxAgent.ts
   private setupTabClosureHandler(): void {
     import('./TabManager').then(({ TabManager }) => {
       const tabManager = TabManager.getInstance();

       tabManager.onTabClosed(async (sessionId: string, tabId: number) => {
         // ... existing closure handling ...
       });
     });
   }
   ```

4. **Verify**:
   - Build extension: `npm run build`
   - Load unpacked extension in Chrome
   - Check console for initialization message
   - Create session, verify TabManager accessible

**Deliverable**: TabManager initialized at service worker level, agents access shared instance.

---

### Phase 4: Automatic Tab Assignment on Session Creation

**Goal**: Sessions automatically bind to active tab when created.

**Steps**:

1. **Update Session constructor**:
   ```typescript
   // src/core/Session.ts
   constructor(...) {
     // ... existing initialization ...

     // NEW: Attempt to bind to active tab
     chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
       const activeTab = tabs[0];
       if (activeTab?.id) {
         try {
           await TabManager.getInstance().bindTabToSession(
             this.conversationId,
             activeTab.id,
             { title: activeTab.title || '', url: activeTab.url || '' }
           );
           this.sessionState.setTabId(activeTab.id);
         } catch (error) {
           console.error('[Session] Failed to bind active tab:', error);
           this.sessionState.setTabId(-1);
         }
       } else {
         this.sessionState.setTabId(-1);
       }
     });
   }
   ```

2. **Add tests**:
   ```typescript
   // tests/integration/session-tab-lifecycle.test.ts
   describe('Automatic tab assignment', () => {
     it('binds to active tab on session creation', async () => {
       const mockTab = { id: 123, title: 'Test', url: 'https://example.com' };
       chrome.tabs.query = vi.fn().mockImplementation((query, callback) => {
         callback([mockTab]);
       });

       const session = new Session(config);
       await new Promise(resolve => setTimeout(resolve, 100)); // Wait for async binding

       expect(session.getTabId()).toBe(123);
     });
   });
   ```

3. **Verify**:
   ```bash
   npm test -- tests/integration/session-tab-lifecycle.test.ts
   ```

**Deliverable**: Sessions automatically bind to active tab, tests passing.

---

### Phase 5: Automatic Tab Creation on First Message

**Goal**: Create new tab when user sends message with tabId = -1.

**Steps**:

1. **Add createAndBindTab() method to TabManager**:
   ```typescript
   // src/core/TabManager.ts
   async createAndBindTab(
     sessionId: string,
     options: { url: string }
   ): Promise<number | null> {
     try {
       const tab = await chrome.tabs.create({ url: options.url });
       if (tab.id) {
         await this.bindTabToSession(sessionId, tab.id, {
           title: tab.title || '',
           url: tab.url || '',
         });
         return tab.id;
       }
       return null;
     } catch (error) {
       console.error('[TabManager] Failed to create tab:', error);
       return null;
     }
   }
   ```

2. **Add tab creation hook to message submission**:
   ```typescript
   // src/core/BrowserxAgent.ts or Session.ts (wherever submitMessage is)
   async submitMessage(message: string) {
     const currentTabId = this.session.getTabId();

     // NEW: Create tab if tabId = -1
     if (currentTabId === -1) {
       const newTabId = await TabManager.getInstance().createAndBindTab(
         this.session.getId(),
         { url: 'about:blank' }
       );

       if (!newTabId) {
         throw new Error('Failed to create tab for session');
       }

       this.session.setTabId(newTabId);
     }

     // Continue with agent processing...
   }
   ```

3. **Add tests**:
   ```typescript
   // tests/integration/session-tab-lifecycle.test.ts
   describe('Automatic tab creation', () => {
     it('creates tab when submitting message with tabId = -1', async () => {
       const session = new Session(config);
       session.setTabId(-1);

       const mockTab = { id: 789, url: 'about:blank' };
       chrome.tabs.create = vi.fn().mockResolvedValue(mockTab);

       await session.submitMessage('Test message');

       expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank' });
       expect(session.getTabId()).toBe(789);
     });
   });
   ```

4. **Verify**:
   ```bash
   npm test -- tests/integration/session-tab-lifecycle.test.ts
   ```

**Deliverable**: New tabs created automatically, about:blank URL, tests passing.

---

### Phase 6: Extract MessageInput.svelte Component

**Goal**: Create independent MessageInput component containing TabContext.

**Steps**:

1. **Create new component**:
   ```svelte
   <!-- src/sidepanel/components/MessageInput.svelte -->
   <script lang="ts">
     import TabContext from './TabContext.svelte';

     export let value: string = '';
     export let onSubmit: (value: string) => void;
     export let tabId: number = -1;
     export let placeholder: string = 'Type a message...';

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
       {placeholder}
       aria-label="Message input"
     />
   </div>

   <style>
     .message-input-container {
       display: flex;
       flex-direction: column;
       gap: 8px;
     }

     textarea {
       /* ... existing styles from TerminalInput ... */
     }
   </style>
   ```

2. **Update App.svelte to use MessageInput**:
   ```svelte
   <!-- src/sidepanel/App.svelte -->
   <script lang="ts">
     import MessageInput from './components/MessageInput.svelte';

     let inputValue = '';

     function handleSubmit(message: string) {
       // ... existing submit logic ...
     }
   </script>

   <MessageInput
     bind:value={inputValue}
     onSubmit={handleSubmit}
     tabId={session.getTabId()}
   />
   ```

3. **Add component tests**:
   ```typescript
   // tests/sidepanel/MessageInput.test.ts
   import { render, fireEvent } from '@testing-library/svelte';
   import MessageInput from '@/sidepanel/components/MessageInput.svelte';

   describe('MessageInput', () => {
     it('renders with TabContext', () => {
       const { container } = render(MessageInput, { props: { tabId: 123 } });
       expect(container.querySelector('[data-testid="tab-context-display"]')).toBeTruthy();
     });

     it('calls onSubmit on Enter key', async () => {
       const onSubmit = vi.fn();
       const { getByRole } = render(MessageInput, { props: { onSubmit } });
       const textarea = getByRole('textbox');

       await fireEvent.keyPress(textarea, { key: 'Enter' });

       expect(onSubmit).toHaveBeenCalled();
     });
   });
   ```

4. **Verify**:
   ```bash
   npm test -- tests/sidepanel/MessageInput.test.ts
   npm run dev  # Visual verification in browser
   ```

**Deliverable**: MessageInput component extracted, tests passing, UI working.

---

### Phase 7: Add TabContext Click + Dropdown

**Goal**: Make TabContext clickable with tab selection dropdown.

**Steps**:

1. **Update TabContext.svelte**:
   ```svelte
   <!-- src/sidepanel/components/TabContext.svelte -->
   <script lang="ts">
     import { onMount, onDestroy } from 'svelte';

     export let tabId: number = -1;

     let showDropdown = false;
     let allTabs: chrome.tabs.Tab[] = [];
     let dropdownRef: HTMLElement;
     let tabTitle: string = '';
     let fullTitle: string = '';
     let displayTitle: string = '';
     let isLoading: boolean = false;
     let error: string | null = null;

     // ... existing tab fetching logic ...

     async function handleClick() {
       if (!showDropdown) {
         try {
           allTabs = await chrome.tabs.query({});
           showDropdown = true;
         } catch (err) {
           console.error('Failed to fetch tabs:', err);
           error = 'Failed to load tabs';
         }
       }
     }

     function handleClickOutside(event: MouseEvent) {
       if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
         showDropdown = false;
       }
     }

     function selectTab(selectedTabId: number) {
       // Emit event to parent
       const event = new CustomEvent('tabSelected', { detail: { tabId: selectedTabId } });
       document.dispatchEvent(event);
       showDropdown = false;
     }

     function selectNewTab() {
       const event = new CustomEvent('tabSelected', { detail: { tabId: -1 } });
       document.dispatchEvent(event);
       showDropdown = false;
     }

     onMount(() => {
       document.addEventListener('click', handleClickOutside);
     });

     onDestroy(() => {
       document.removeEventListener('click', handleClickOutside);
     });
   </script>

   <div
     class="tab-context"
     class:clickable={true}
     title={fullTitle}
     on:click={handleClick}
     data-testid="tab-context-display"
     aria-label="Current tab context"
   >
     {#if isLoading}
       <span class="tab-context-loading">Loading...</span>
     {:else if error}
       <span class="tab-context-error">{error}</span>
     {:else}
       <span class="tab-context-title">{displayTitle}</span>
     {/if}
   </div>

   {#if showDropdown}
     <div class="dropdown" bind:this={dropdownRef}>
       <div class="dropdown-item" on:click={selectNewTab}>
         + New Tab
       </div>
       {#each allTabs as tab}
         <div class="dropdown-item" on:click={() => selectTab(tab.id)}>
           {tab.title || 'Untitled'}
         </div>
       {/each}
     </div>
   {/if}

   <style>
     .tab-context.clickable {
       cursor: pointer;
     }

     .dropdown {
       position: absolute;
       background: var(--color-term-black);
       border: 1px solid var(--color-term-green);
       max-height: 300px;
       overflow-y: auto;
       z-index: 1000;
     }

     .dropdown-item {
       padding: 8px;
       cursor: pointer;
     }

     .dropdown-item:hover {
       background: var(--color-term-dim-green);
     }
   </style>
   ```

2. **Update parent to handle tab selection**:
   ```svelte
   <!-- src/sidepanel/App.svelte -->
   <script lang="ts">
     import { onMount, onDestroy } from 'svelte';

     function handleTabSelected(event: CustomEvent) {
       const { tabId } = event.detail;

       if (tabId === -1) {
         session.setTabId(-1);
       } else {
         TabManager.getInstance().bindTabToSession(session.getId(), tabId, {});
         session.setTabId(tabId);
       }
     }

     onMount(() => {
       document.addEventListener('tabSelected', handleTabSelected);
     });

     onDestroy(() => {
       document.removeEventListener('tabSelected', handleTabSelected);
     });
   </script>
   ```

3. **Add tests**:
   ```typescript
   // tests/integration/tab-context-display.test.ts
   describe('TabContext dropdown', () => {
     it('opens dropdown on click', async () => {
       const { getByTestId, container } = render(TabContext, { props: { tabId: 123 } });

       await fireEvent.click(getByTestId('tab-context-display'));

       expect(container.querySelector('.dropdown')).toBeTruthy();
     });

     it('closes dropdown on outside click', async () => {
       const { getByTestId, container } = render(TabContext, { props: { tabId: 123 } });

       await fireEvent.click(getByTestId('tab-context-display'));
       await fireEvent.click(document.body);

       expect(container.querySelector('.dropdown')).toBeFalsy();
     });
   });
   ```

4. **Verify**:
   ```bash
   npm test -- tests/integration/tab-context-display.test.ts
   npm run dev  # Visual verification
   ```

**Deliverable**: Clickable TabContext with dropdown menu, tests passing.

---

### Phase 8: Exclude TabTool from LLM

**Goal**: Prevent TabTool from being exposed to LLM.

**Steps**:

1. **Update tool registration**:
   ```typescript
   // src/tools/index.ts
   export async function registerTools(registry: ToolRegistry, config: IToolsConfig) {
     // ... register other tools ...

     // FR-023: Do NOT expose TabTool to LLM (agent manages tabs automatically)
     // registry.register(new TabTool()); // COMMENTED OUT

     // ... continue with other tools ...
   }
   ```

2. **Add verification test**:
   ```typescript
   // tests/integration/tool-registry.test.ts
   describe('Tool registration', () => {
     it('does not include TabTool in LLM tools', () => {
       const registry = new ToolRegistry();
       registerTools(registry, config);

       const tools = registry.listTools();
       expect(tools.find(t => t.name === 'TabTool')).toBeUndefined();
     });
   });
   ```

3. **Verify**:
   ```bash
   npm test -- tests/integration/tool-registry.test.ts
   ```

**Deliverable**: TabTool excluded from LLM, verification test passing.

---

## Testing Strategy

### Unit Tests

Run specific test files:
```bash
npm test -- tests/unit/TabManager.test.ts
npm test -- tests/sidepanel/MessageInput.test.ts
```

### Integration Tests

Run integration test suite:
```bash
npm test -- tests/integration/
```

### Contract Tests

Run contract tests to verify API compliance:
```bash
npm test -- tests/contract/tab-binding.contract.test.ts
```

### Manual Testing Checklist

Load unpacked extension and verify:

- [ ] Create session → Binds to active tab automatically
- [ ] Create session with no tabs → tabId = -1
- [ ] Send message with tabId = -1 → Creates new tab with about:blank
- [ ] Click TabContext → Dropdown appears with all tabs
- [ ] Select tab from dropdown → Session binds to selected tab
- [ ] Select "New Tab" from dropdown → tabId = -1
- [ ] Click outside dropdown → Dropdown closes
- [ ] Close bound tab → Session tabId resets to -1
- [ ] Bind two sessions to same tab → Last-write-wins, first session loses binding
- [ ] All tabs in "browserx" group with blue color

---

## Troubleshooting

### Build Errors

**Issue**: TypeScript errors after renaming TabBindingManager
**Fix**: Ensure all imports updated, run `npm run type-check` to find remaining references

### Test Failures

**Issue**: Tests fail after merging TabGroupManager
**Fix**: Update test expectations, verify chrome-mock configured correctly

### Chrome API Errors

**Issue**: "Cannot read property 'create' of undefined"
**Fix**: Check manifest.json has `tabs` and `tabGroups` permissions

### Dropdown Not Showing

**Issue**: TabContext click doesn't open dropdown
**Fix**: Check z-index, verify event listener registered, check console for errors

---

## Common Pitfalls

1. **Forgetting to await async operations** - TabManager methods are async, always use `await`
2. **Not handling tabId = -1 state** - Check for -1 before tab operations
3. **Circular imports** - Use dynamic imports if needed: `import('./TabManager').then(...)`
4. **Test isolation** - Reset TabManager singleton between tests: `TabManager['instance'] = null`
5. **Chrome API mocking** - Ensure chrome-mock configured for all used APIs

---

## Performance Monitoring

Add performance logging during development:

```typescript
// src/core/TabManager.ts
async bindTabToSession(sessionId: string, tabId: number, tabInfo: TabInfo): Promise<void> {
  const start = performance.now();

  // ... implementation ...

  const duration = performance.now() - start;
  if (duration > 50) {
    console.warn(`[TabManager] bindTabToSession took ${duration}ms (expected <50ms)`);
  }
}
```

---

## Next Steps After Completion

1. Run full test suite: `npm test`
2. Build extension: `npm run build`
3. Load in Chrome and perform manual testing
4. Create PR with descriptive title referencing feature branch `001-tab-manager`
5. Request code review
6. Address review feedback
7. Merge to main after approval

---

## Support Resources

- **Spec**: [spec.md](./spec.md)
- **Research**: [research.md](./research.md)
- **Data Model**: [data-model.md](./data-model.md)
- **API Contract**: [contracts/tab-manager-api.md](./contracts/tab-manager-api.md)
- **Chrome Extensions API**: https://developer.chrome.com/docs/extensions/
- **Svelte Docs**: https://svelte.dev/docs
- **Vitest Docs**: https://vitest.dev/

---

**Good luck with implementation! Follow the phases sequentially for best results.**
