# Implementation Plan: Svelte 5 Migration

**Branch**: `039-svelte5-migration` | **Date**: 2026-03-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/039-svelte5-migration/spec.md`

## Summary

Migrate all 69 Svelte components from Svelte 4 syntax to Svelte 5 runes and modern APIs. The codebase already uses Svelte 5 (`^5.53.7`) with backward compatibility mode. This migration replaces `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `createEventDispatcher` with callback props, `on:event` with `onevent`, `<slot>` with `{@render}` snippets, and manual store `.subscribe()` with `$store` auto-subscriptions. No new features - purely a syntax modernization.

## Technical Context

**Language/Version**: TypeScript 5.9 + Svelte 5.53.7
**Primary Dependencies**: Svelte 5, Vite 6, svelte-spa-router 4, Tailwind CSS 4, tippy.js
**Storage**: N/A (no storage changes)
**Testing**: Vitest 3.2 + @testing-library/svelte 5.2
**Target Platform**: Chrome Extension + Tauri Desktop (Linux, macOS, Windows)
**Project Type**: Web application (extension + desktop)
**Performance Goals**: No regressions - identical runtime behavior
**Constraints**: Must maintain backward compatibility with svelte-spa-router (Svelte 4 component internally)
**Scale/Scope**: 69 `.svelte` files in `src/`, 8 store modules, ~241 event handler occurrences

## Constitution Check

*GATE: No project constitution has been configured. Proceeding with standard best practices.*

N/A - Constitution file contains only template placeholders.

## Project Structure

### Documentation (this feature)

```text
specs/039-svelte5-migration/
├── spec.md              # Feature specification
└── plan.md              # This file
```

### Source Code (repository root)

```text
src/
├── webfront/
│   ├── App.svelte                          # Root app component
│   ├── components/
│   │   ├── chat/                           # Chat UI components (3 files)
│   │   ├── common/                         # Reusable UI components (7 files)
│   │   ├── event_display/                  # Event rendering components (9 files)
│   │   ├── layout/                         # Layout components (5 files)
│   │   ├── scheduler/                      # Scheduler UI components (5 files)
│   │   ├── vault/                          # PIN/vault components (2 files)
│   │   ├── CommandDropdown.svelte
│   │   ├── CommandError.svelte
│   │   ├── MessageDisplay.svelte
│   │   ├── MessageInput.svelte
│   │   ├── TerminalContainer.svelte
│   │   ├── TerminalInput.svelte
│   │   └── TerminalMessage.svelte
│   ├── pages/                              # Page components (4 files)
│   ├── settings/                           # Settings panel components (12 files)
│   └── stores/                             # Svelte stores (8 files, NOT migrated - writable/derived still valid)
├── extension/content/ui_effect/            # Extension overlay components (4 files)
├── welcome/Welcome.svelte                  # Welcome page
├── tests/TestApp.svelte                    # Test wrapper
└── __test-utils__/mocks/                   # Mock components (3 files)
```

**Structure Decision**: No structural changes. Migration is in-place, file-by-file. Stores remain using `svelte/store` (`writable`/`derived`) which are fully supported in Svelte 5.

## Migration Strategy

### Approach: Bottom-Up, Component-by-Component

Migrate leaf components first (no children), then work up to parent components. This ensures that when a parent is migrated, all its children already use the new API.

### Migration Tiers

**Tier 1 - Leaf Components (no children, simple props)**
Small components with few dependencies. Low risk, high volume.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| Switch.svelte | `export let`, `createEventDispatcher`, `on:click`, `on:keydown` | Low |
| CommandError.svelte | `export let` | Low |
| TerminalMessage.svelte | `export let`, `.subscribe()` | Low |
| TerminalInput.svelte | `export let` | Low |
| Credits.svelte | `.subscribe()` | Low |
| ModelInfoTooltip.svelte | `export let` | Low |
| ModelOption.svelte | `export let`, `createEventDispatcher`, `on:click` | Low |
| ApprovalModeIndicator.svelte | `export let`, `.subscribe()` | Low |
| UserLoginStatus.svelte | `export let`, `.subscribe()`, `on:click` | Low |
| SystemEvent.svelte | `export let` | Low |
| ErrorEvent.svelte | `export let` | Low |
| OutputEvent.svelte | `export let`, `$:` | Low |
| ReasoningEvent.svelte | `export let`, `$:` | Low |
| MessageEvent.svelte | `export let`, `.subscribe()` | Low |
| PlanEvent.svelte | `export let`, `$:` | Low |
| MockAgentStatus.svelte | `export let` | Low |
| MockSettingsPanel.svelte | `export let` | Low |
| MockTaskDisplay.svelte | `export let` | Low |

**Tier 2 - Interactive Leaf Components (event dispatchers, reactivity)**
Components that dispatch events to parents or have significant reactive logic.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| ToolCallEvent.svelte | `export let`, `$:`, `on:click` | Medium |
| TaskEvent.svelte | `export let`, `createEventDispatcher`, `.subscribe()` | Medium |
| ApprovalEvent.svelte | `export let`, `createEventDispatcher`, `on:click` | Medium |
| SchedulerJobItem.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `on:click` | Medium |
| NavTab.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:` | Medium |
| SettingsSearch.svelte | `export let`, `createEventDispatcher`, `$:`, `on:input` | Medium |
| SettingsMenu.svelte | `export let`, `createEventDispatcher`, `on:click` | Medium |
| UnsavedChangesDialog.svelte | `export let`, `createEventDispatcher`, `on:click` | Medium |
| ModelSelection.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:` | Medium |
| ModelSelector.svelte | `export let`, `createEventDispatcher`, `$:` | Medium |
| ChatHistoryList.svelte | `export let`, `$:`, `.subscribe()`, `on:click` | Medium |
| PinSetupDialog.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |
| PinUnlockOverlay.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |
| ControlButtons.svelte | `export let`, `createEventDispatcher`, `on:click` | Medium |
| CommandDropdown.svelte | `export let`, `createEventDispatcher`, `afterUpdate`, `$:`, `on:click` | Medium |
| MessageInput.svelte | `export let`, `createEventDispatcher`, `$:`, `on:input`, `on:keydown` | Medium |
| SchedulerButton.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `on:click` | Medium |

**Tier 3 - Wrapper/Slot Components**
Components using `<slot>` that need snippet migration.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| TerminalContainer.svelte | `export let`, `<slot>` | Low |
| Portal.svelte | `export let`, `<slot>` | Low |
| Tooltip.svelte | `export let`, `<slot>`, `$:`, `.subscribe()` | Medium |
| AppShell.svelte | `<slot>`, `.subscribe()` | Medium |
| PopupCard.svelte | `export let`, `<slot name="trigger">`, `<slot name="content">`, `$:`, `.subscribe()`, `on:click` | High |

**Tier 4 - Settings Panels (high-volume event dispatchers)**
Settings components with multiple dispatch events and store interactions.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| GeneralSettings.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `on:change` | Medium |
| ModelSettings.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |
| AdvancedModelConfig.svelte | `export let`, `createEventDispatcher`, `$:` | Medium |
| StorageSettings.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |
| ToolsSettings.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `on:click` | Medium |
| ExtensionSettings.svelte | `export let`, `createEventDispatcher`, `$:`, `on:change` | Medium |
| MCPSettings.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `on:click` | Medium |
| A2ASettings.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |
| ApprovalSettings.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `on:click` | Medium |
| SecuritySettings.svelte | `export let`, `createEventDispatcher`, `$:`, `on:click` | Medium |

**Tier 5 - Container/Parent Components**
Components that compose children and must update event handling to match new child APIs.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| TabContext.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `<slot>` | Medium |
| EventDisplay.svelte | `export let`, `$:`, `.subscribe()`, `on:click`, `on:keydown` | Medium |
| ChatHistoryPopup.svelte | `export let`, `.subscribe()`, `$:` | Medium |
| FooterBar.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `on:click` | Medium |
| LeftPanel.svelte | `export let`, `.subscribe()`, `$:`, `<slot>` | Medium |
| ScheduleJobModal.svelte | `export let`, `createEventDispatcher`, `.subscribe()`, `$:`, `on:click` | High |
| SchedulerPopup.svelte | `export let`, `.subscribe()`, `$:`, `on:click` | High |
| ArchivedJobsView.svelte | `export let`, `.subscribe()`, `$:`, `on:click` | Medium |
| MessageDisplay.svelte | `export let`, `.subscribe()`, `$:` | Medium |

**Tier 6 - Page Components & Extension Components**
Top-level pages that compose everything, plus extension overlay components.

| Component | Patterns to Migrate | Complexity |
|-----------|-------------------|------------|
| Settings.svelte (page) | `.subscribe()`, dispatched events from children | High |
| Skills.svelte (page) | `.subscribe()`, `on:click` | Medium |
| Scheduler.svelte (page) | `$:`, `.subscribe()`, `on:click` | High |
| Main.svelte (chat page) | `$:`, `.subscribe()` | High |
| App.svelte | `on:unlocked` callback, `$vaultStore` | Medium |
| Welcome.svelte | `export let` | Low |
| VisualEffectController.svelte | `export let`, `$:`, `.subscribe()` | High |
| Overlay.svelte | `export let`, `<slot>`, `.subscribe()` | Medium |
| CursorAnimator.svelte | `export let`, `$:`, `.subscribe()` | High |
| TestApp.svelte | `export let` | Low |

### Migration Patterns Reference

#### Pattern 1: `export let` -> `$props()`
```svelte
// Before (Svelte 4)
export let title: string = '';
export let show: boolean = false;
export let onClose: () => void = () => {};

// After (Svelte 5)
let { title = '', show = false, onClose = () => {} }: {
  title?: string;
  show?: boolean;
  onClose?: () => void;
} = $props();
```

#### Pattern 2: `$:` -> `$derived()` / `$effect()`
```svelte
// Before - derived value
$: fullName = `${firstName} ${lastName}`;

// After
let fullName = $derived(`${firstName} ${lastName}`);

// Before - side effect
$: if (tippyInstance) { tippyInstance.setContent(content); }

// After
$effect(() => { if (tippyInstance) { tippyInstance.setContent(content); } });
```

#### Pattern 3: `createEventDispatcher` -> callback props
```svelte
// Before (child)
import { createEventDispatcher } from 'svelte';
const dispatch = createEventDispatcher<{ change: boolean }>();
dispatch('change', value);

// After (child)
let { onChange }: { onChange?: (value: boolean) => void } = $props();
onChange?.(value);

// Before (parent)
<Switch on:change={(e) => handleChange(e.detail)} />

// After (parent)
<Switch onChange={(value) => handleChange(value)} />
```

#### Pattern 4: `on:event` -> `onevent`
```svelte
// Before
<button on:click={handleClick} on:keydown={handleKeyDown}>

// After
<button onclick={handleClick} onkeydown={handleKeyDown}>

// Before (with modifiers)
<button on:click|stopPropagation={handler}>

// After (inline wrapper)
<button onclick={(e) => { e.stopPropagation(); handler(e); }}>
```

#### Pattern 5: `<slot>` -> `{@render}`
```svelte
// Before
<slot />
<slot name="trigger" />

// After
{@render children?.()}
{@render trigger?.()}

// Props declaration for snippets
import type { Snippet } from 'svelte';
let { children, trigger }: {
  children?: Snippet;
  trigger?: Snippet;
} = $props();
```

#### Pattern 6: Manual `.subscribe()` -> `$store`
```svelte
// Before
let currentTheme: UITheme = 'terminal';
uiTheme.subscribe((theme) => { currentTheme = theme; });

// After - use $uiTheme directly in template/logic
// No need for currentTheme variable
<div class={$uiTheme === 'modern' ? 'font-chat' : 'font-terminal'}>
```

#### Pattern 7: `afterUpdate` -> `$effect()`
```svelte
// Before
import { afterUpdate } from 'svelte';
afterUpdate(() => { scrollToSelected(); });

// After
$effect(() => {
  // Reference reactive dependencies explicitly
  selectedIndex;
  scrollToSelected();
});
```

## Complexity Tracking

No constitution violations to track. This is a straightforward syntax migration with no architectural changes.
