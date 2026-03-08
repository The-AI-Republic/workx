# Feature Specification: Svelte 5 Migration

**Feature Branch**: `039-svelte5-migration`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "Migrate Svelte components from Svelte 4 syntax to Svelte 5 runes and modern APIs"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Props Migration (Priority: P1)

All Svelte components using `export let` for props are migrated to use `$props()` runes. This is the most foundational change and affects nearly every component.

**Why this priority**: `export let` is the most pervasive Svelte 4 pattern (121 occurrences across 47 files). It is the base syntax change that other migrations depend on. Components must receive props via `$props()` for a consistent runes-based codebase.

**Independent Test**: Can be tested by running `npm run type-check` and `npm test` after migrating props in any single component, verifying the component still renders and receives props correctly.

**Acceptance Scenarios**:

1. **Given** a component using `export let prop`, **When** migrated to `let { prop } = $props()`, **Then** the component renders identically and all parent usages continue to work without changes.
2. **Given** a component with typed props and defaults, **When** migrated, **Then** TypeScript types and default values are preserved via `$props()` destructuring with defaults.
3. **Given** a component with `export let` and `$:` reactive dependencies on those props, **When** props are migrated, **Then** derived values update correctly when props change.

---

### User Story 2 - Reactivity Migration (Priority: P1)

All `$:` reactive declarations and statements are migrated to `$derived()` and `$effect()` runes.

**Why this priority**: Reactive declarations (`$:`) are the second most common pattern (99 occurrences across 39 files) and are central to component behavior. They must be migrated alongside props for consistent runes usage.

**Independent Test**: Each component's reactive behavior can be independently verified by testing that derived values update when dependencies change, and side effects fire at the correct times.

**Acceptance Scenarios**:

1. **Given** a `$: derivedValue = expr` declaration, **When** migrated to `let derivedValue = $derived(expr)`, **Then** the derived value updates reactively when dependencies change.
2. **Given** a `$: { sideEffect() }` statement block, **When** migrated to `$effect(() => { sideEffect() })`, **Then** the side effect runs when dependencies change and cleans up properly.
3. **Given** a `$: if (condition) { ... }` conditional reactive block, **When** migrated to `$effect()`, **Then** the effect only runs when the condition's dependencies change.

---

### User Story 3 - Event Handling Migration (Priority: P2)

All `createEventDispatcher()` usages are replaced with callback props, and `on:event` directive syntax is replaced with `onevent` attribute syntax.

**Why this priority**: Event handling changes (241 `on:event` occurrences across 46 files, 26 components using `createEventDispatcher`) are mechanical but high-volume. They affect component APIs and parent-child contracts.

**Independent Test**: Each component's event handling can be tested by verifying that callback props are invoked with the correct arguments when user interactions occur.

**Acceptance Scenarios**:

1. **Given** a component using `createEventDispatcher` with `dispatch('change', value)`, **When** migrated to a callback prop `onChange`, **Then** parent components call the component with `onChange={(value) => ...}` and behavior is identical.
2. **Given** a template using `on:click={handler}`, **When** migrated to `onclick={handler}`, **Then** click events are handled identically.
3. **Given** a template using `on:click|stopPropagation={handler}`, **When** migrated, **Then** event modifiers are handled inline (e.g., wrapping handler with `e.stopPropagation()`).
4. **Given** `<svelte:window on:click={handler} />`, **When** migrated to `<svelte:window onclick={handler} />`, **Then** window-level events are handled identically.

---

### User Story 4 - Slots to Snippets Migration (Priority: P2)

All `<slot>` and `<slot name="...">` usages are migrated to Svelte 5 snippets with `{@render children()}`.

**Why this priority**: Slot usage is limited to 6 wrapper/layout components (Portal, PopupCard, Tooltip, AppShell, TerminalContainer, PopupCard named slots). This is a smaller but important API change.

**Independent Test**: Each component with slots can be tested by verifying that content projection still works correctly after migration to snippets.

**Acceptance Scenarios**:

1. **Given** a component using `<slot />`, **When** migrated to `{@render children?.()}` with `children` as a snippet prop, **Then** child content renders identically.
2. **Given** a component using `<slot name="trigger" />` and `<slot name="content" />`, **When** migrated to named snippet props, **Then** both named content areas render correctly.
3. **Given** a parent using `<Component><div>content</div></Component>`, **When** the child migrates to snippets, **Then** no changes are needed in the parent template.

---

### User Story 5 - Store Subscription Cleanup (Priority: P3)

Manual `.subscribe()` calls on Svelte stores are replaced with the `$store` auto-subscription syntax where possible, reducing boilerplate and preventing memory leaks from forgotten unsubscriptions.

**Why this priority**: There are 41 manual `.subscribe()` calls (primarily `uiTheme.subscribe()`). Many lack corresponding `onDestroy` cleanup, risking memory leaks. The `$store` syntax handles subscription lifecycle automatically.

**Independent Test**: Can be tested by verifying that theme changes propagate correctly and that components unmount cleanly without leaked subscriptions.

**Acceptance Scenarios**:

1. **Given** a component with `uiTheme.subscribe((theme) => { currentTheme = theme })`, **When** replaced with `$uiTheme` auto-subscription in the template or via `$derived`, **Then** theme updates propagate identically and subscription is auto-cleaned on destroy.
2. **Given** a component that needs the store value in a reactive context, **When** using `$uiTheme` directly in templates or `$derived`, **Then** the value is always current.

---

### User Story 6 - Lifecycle & Deprecated API Cleanup (Priority: P3)

Migrate `afterUpdate` to `$effect`, and ensure `onMount`/`onDestroy` patterns are clean (these remain valid in Svelte 5 but some can be simplified with `$effect`).

**Why this priority**: Only 1 component uses `afterUpdate` (CommandDropdown.svelte). This is a small cleanup task.

**Independent Test**: Verify CommandDropdown auto-scrolls correctly after migration.

**Acceptance Scenarios**:

1. **Given** `afterUpdate(() => { scrollToSelected() })` in CommandDropdown, **When** migrated to `$effect()`, **Then** the dropdown still auto-scrolls to the selected item after updates.

---

### Edge Cases

- What happens when a parent passes `on:event` forwarding to a child that has been migrated to callback props? Both parent and child must be updated together.
- How are `on:click|stopPropagation` and other event modifiers handled without the `|` modifier syntax? Use inline wrappers: `onclick={(e) => { e.stopPropagation(); handler(e); }}`.
- What happens with `<slot>` fallback content when migrating to snippets? Use optional chaining: `{@render children?.()}`.
- Store auto-subscriptions (`$store`) in the extension content scripts (`src/extension/`) where component lifecycle may differ from standard webfront components.
- The `svelte-spa-router` library uses Svelte 4 internally - ensure it remains compatible.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `export let` prop declarations MUST be migrated to `$props()` destructuring with preserved types and defaults.
- **FR-002**: All `$:` reactive declarations MUST be migrated to `$derived()` (for computed values) or `$effect()` (for side effects).
- **FR-003**: All `createEventDispatcher()` usages MUST be replaced with callback props (e.g., `onChange`, `onSelect`).
- **FR-004**: All `on:event` directive syntax MUST be migrated to `onevent` attribute syntax (e.g., `on:click` to `onclick`).
- **FR-005**: All `<slot>` usages MUST be migrated to Svelte 5 snippet syntax using `{@render}`.
- **FR-006**: Manual `.subscribe()` calls on stores SHOULD be replaced with `$store` auto-subscription where safe and appropriate.
- **FR-007**: `afterUpdate` lifecycle hook MUST be replaced with `$effect()`.
- **FR-008**: All existing unit tests MUST continue to pass after migration.
- **FR-009**: TypeScript type-checking (`npm run type-check`) MUST pass after migration.
- **FR-010**: Visual behavior and user interactions MUST remain identical post-migration (no visual regressions).

### Key Entities

- **SvelteComponent**: Any `.svelte` file in `src/` (65 application components, 4 test utility components)
- **SvelteStore**: Svelte store modules in `src/webfront/stores/` (8 stores using `writable`/`derived` from `svelte/store`)
- **EventContract**: The interface between parent and child components for event communication (dispatch -> callback props)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero `export let` declarations remain in any `.svelte` file under `src/` (currently 121 occurrences across 47 files).
- **SC-002**: Zero `$:` reactive labels remain in any `.svelte` file under `src/` (currently 99 occurrences across 39 files).
- **SC-003**: Zero `createEventDispatcher` imports remain in any `.svelte` file under `src/` (currently 26 components).
- **SC-004**: Zero `on:event` directive syntax remains in any `.svelte` file under `src/` (currently 241 occurrences across 46 files).
- **SC-005**: Zero `<slot` tags remain in any `.svelte` file under `src/` (currently 6 files).
- **SC-006**: All existing tests pass (`npm test`).
- **SC-007**: TypeScript type-checking passes (`npm run type-check`).
- **SC-008**: Zero `afterUpdate` or `beforeUpdate` imports remain.
