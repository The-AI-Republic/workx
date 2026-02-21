# Research: Slash Command System

**Feature**: 021-slash-commands
**Date**: 2026-02-16

## Decision 1: Command Detection Strategy

**Decision**: Detect "/" as command trigger only when it is the first character typed into an empty input field. Use the existing `handleKeyDown` in MessageInput.svelte as the interception point.

**Rationale**: The existing `handleKeyDown` already intercepts Enter. Adding "/" detection at the same point keeps all input interception logic co-located. The "empty field only" rule (FR-001, FR-019) prevents false triggers when users type URLs or file paths mid-message.

**Alternatives considered**:
- Global keyboard shortcut (rejected: conflicts with extension commands Alt+Shift+C/Q)
- Separate command input field (rejected: breaks single-input UX, adds complexity)
- Detect "/" anywhere with escape sequences (rejected: over-engineered, confuses users)

## Decision 2: Command Registry Pattern

**Decision**: Singleton class with Map-based storage, case-insensitive keys (lowercase normalized). Commands registered at module initialization time. Registry is framework-agnostic TypeScript — no Svelte dependency.

**Rationale**: Map provides O(1) lookup by name (FR-012). Singleton ensures single source of truth across the app (FR-016 cross-platform). Keeping it framework-agnostic allows reuse if the project adds other UI surfaces. Mirrors Claude Code's approach of a simple registry with command definitions.

**Alternatives considered**:
- Svelte store as registry (rejected: couples data layer to framework, harder to test)
- Event-based command bus (rejected: over-engineered for client-side UI commands)
- Static array with linear search (rejected: O(n) lookup, doesn't scale)

## Decision 3: Dropdown Component Architecture

**Decision**: New `CommandDropdown.svelte` component rendered inside MessageInput.svelte, positioned absolutely relative to the input container. Uses Portal.svelte for z-index escape. Visibility controlled by a reactive boolean in MessageInput.

**Rationale**: The existing PopupCard.svelte is designed for trigger-based fixed-position overlays, but the command dropdown needs to be tightly coupled to the input's text state (filtering as you type). A purpose-built component is simpler. Portal.svelte already exists for escaping stacking contexts.

**Alternatives considered**:
- Reuse PopupCard.svelte (rejected: PopupCard is trigger-click based, not text-input driven)
- Use Tippy.js tooltip (rejected: Tippy is for hover/click tooltips, not filterable lists)
- Render dropdown in Main.svelte (rejected: leaks input-level concern to page level)

## Decision 4: Input Parsing Strategy

**Decision**: Split input on first space character to extract command name and argument string. Command name normalized to lowercase for lookup. Remainder passed as-is to command action.

**Rationale**: Mirrors Claude Code's approach (FR-020). Simple and predictable. The first-space split is a well-understood convention (shell commands, IRC, Discord bots). No need for complex argument parsing at the framework level.

**Alternatives considered**:
- Regex-based parsing (rejected: over-engineered for v1)
- Tokenizer with quoted string support (rejected: premature complexity)

## Decision 5: /help Command Output

**Decision**: The /help command renders its output as a system event in the conversation area (using the existing ProcessedEvent system with category 'system'). This keeps it consistent with how the app displays information.

**Rationale**: The chat area already supports rendering ProcessedEvent objects with different categories and styles. Rendering /help output there is natural and visible. An alternative modal or dropdown would be inconsistent.

**Alternatives considered**:
- Show help in the dropdown itself (rejected: dropdown is for command selection, not content display)
- Show help in a modal (rejected: inconsistent with existing UX patterns; settings uses modal but help is informational)

## Decision 6: Error Message Component

**Decision**: New `CommandError.svelte` component rendered above the input in MessageInput.svelte. Uses absolute positioning, z-index 40. Auto-dismiss via setTimeout (60s). Dismisses on input change.

**Rationale**: FR-007/008/009 require inline errors above the input with auto-dismiss. This is a small, self-contained component. Z-index 40 keeps it below the dropdown (50) but above normal content.

**Alternatives considered**:
- Reuse existing ErrorEvent.svelte (rejected: ErrorEvent is for conversation errors, not input-level errors)
- Toast notification library (rejected: adds dependency, not inline above input)

## Decision 7: State Management Approach

**Decision**: Local component state in MessageInput.svelte for command mode, dropdown visibility, selected index, error message, and filter text. No Svelte store needed. The CommandRegistry singleton is plain TypeScript.

**Rationale**: Command mode state is entirely local to the input interaction — no other component needs to know if the dropdown is open or what's selected. Svelte stores are for shared cross-component state. Keeping this local minimizes coupling and simplifies testing.

**Alternatives considered**:
- Dedicated commandStore.ts (rejected: no cross-component state sharing needed)
- State machine library (rejected: over-engineered for this interaction)

## Decision 8: Filtering Algorithm

**Decision**: Two-pass filter: first prefix-match on command name (case-insensitive), then substring-match on description (case-insensitive). Results merged with name-matches first, description-matches second (no duplicates).

**Rationale**: Per clarification session answer. Prefix on name provides predictable primary matching. Substring on description enables discovery (e.g., typing "reset" finds "/new" via its description). Name-matches sorted first ensures the most relevant results appear at the top.

**Alternatives considered**:
- Fuzzy matching (rejected: adds complexity, less predictable for small command sets)
- Name-only prefix (rejected: loses description-based discovery)

## Decision 9: Testing Strategy

**Decision**: Unit tests for CommandRegistry (pure TypeScript, no DOM). Component tests for CommandDropdown and CommandError using @testing-library/svelte. Integration test for the full slash command flow in MessageInput context.

**Rationale**: The project already uses Vitest + @testing-library/svelte with JSDOM. Tests exist at `tests/sidepanel/MessageInput.test.ts`. Follow the existing pattern. CommandRegistry is pure logic — easiest to test. Component tests verify rendering and interaction. Integration test verifies end-to-end flow.

**Alternatives considered**:
- E2E tests only (rejected: too slow, existing pattern is unit + component)
- Contract tests (rejected: no backend contract to verify for this feature)

## Decision 10: Built-in Command Actions

**Decision**:
- `/new`: Calls `onNewConversation()` callback prop (already wired to `startNewConversation()` in Main.svelte)
- `/help`: Dispatches a new `commandOutput` event with formatted command list, handled by Main.svelte to create a ProcessedEvent
- `/settings`: Dispatches a new `openSettings` event, handled by Main.svelte (already has `toggleSettings()`)

**Rationale**: MessageInput already communicates with Main.svelte via callback props and custom events. `/new` reuses the existing `onNewConversation` prop. `/help` and `/settings` use event dispatch (consistent with existing `tabSelected` and `showScheduleModal` events). This avoids the command system needing direct access to application state.

**Alternatives considered**:
- Direct store manipulation from commands (rejected: breaks component encapsulation)
- Pass all services to CommandRegistry (rejected: couples registry to app architecture)
