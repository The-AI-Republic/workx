# Implementation Plan: Slash Command System

**Branch**: `021-slash-commands` | **Date**: 2026-02-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/021-slash-commands/spec.md`

## Summary

Implement an extensible slash command system for the side panel that enables quick actions via "/" prefix in the input field. The system includes a command registry (singleton, Map-based), a filterable dropdown with keyboard/mouse navigation, inline error display, and three built-in commands (/new, /help, /settings). Commands support optional raw string arguments. The implementation enhances the existing MessageInput.svelte component and integrates with Main.svelte via callback props and custom events.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (strict mode, ES2020 target)
**Primary Dependencies**: Svelte 4.2.20, Tailwind CSS 4.1.13, Tippy.js 6.3.7 (existing — not used by this feature directly)
**Storage**: N/A (in-memory only, no persistence)
**Testing**: Vitest 3.2.4, @testing-library/svelte 5.2.8, JSDOM
**Target Platform**: Chrome extension (Manifest V3) + Tauri 2.x desktop app (dual-build)
**Project Type**: Single project with extension/desktop build modes
**Performance Goals**: <10ms command detection, <50ms execution, <100ms dropdown render (per user description)
**Constraints**: Must work identically on both platforms (FR-016). Must not break existing Enter-to-send behavior. Z-index layering: dropdown (50) > errors (40).
**Scale/Scope**: ~3 built-in commands at launch, expected to grow to 10-20 commands over time. Small command set means O(n) filtering is acceptable.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution is a placeholder template (no project-specific principles defined). No gates to enforce. Proceeding.

**Post-Phase 1 re-check**: No violations. The design follows existing project patterns (Svelte stores, component composition, callback props, event dispatch). No new dependencies added. No new build configurations required.

## Project Structure

### Documentation (this feature)

```text
specs/021-slash-commands/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: technical decisions
├── data-model.md        # Phase 1: entity definitions
├── quickstart.md        # Phase 1: implementation guide
├── contracts/           # Phase 1: TypeScript interfaces
│   ├── command-registry.ts
│   └── command-events.ts
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/extension/sidepanel/
├── commands/                          # NEW: Command system module
│   ├── CommandRegistry.ts             # Singleton registry with Map-based lookup
│   ├── builtinCommands.ts             # /new, /help, /settings registration
│   └── index.ts                       # Public API, initializes built-ins
├── components/
│   ├── MessageInput.svelte            # MODIFIED: Add command detection, dropdown, errors
│   ├── CommandDropdown.svelte         # NEW: Filterable command list dropdown
│   └── CommandError.svelte            # NEW: Inline error display above input
└── pages/chat/
    └── Main.svelte                    # MODIFIED: Handle commandOutput, openSettings events

tests/
├── unit/commands/
│   └── CommandRegistry.test.ts        # NEW: Registry unit tests
├── sidepanel/
│   ├── CommandDropdown.test.ts        # NEW: Dropdown component tests
│   ├── CommandError.test.ts           # NEW: Error component tests
│   └── SlashCommand.integration.test.ts # NEW: End-to-end command flow
```

**Structure Decision**: The `commands/` module is placed under `src/extension/sidepanel/` because the slash command system is a UI-layer feature specific to the side panel. It does not belong in `src/core/` (which handles messaging and agent logic) or `src/types/` (which holds shared type definitions). The registry is pure TypeScript with no Svelte dependency, making it independently testable.

## Complexity Tracking

No complexity violations. The design uses:
- 1 new module directory (`commands/`) with 3 files
- 2 new Svelte components (dropdown, error)
- 2 modified Svelte components (MessageInput, Main)
- No new dependencies
- No new build configuration
- No new stores (state is component-local)
