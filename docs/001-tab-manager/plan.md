# Implementation Plan: Tab Manager Refactoring

**Branch**: `001-tab-manager` | **Date**: 2025-11-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-tab-manager/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

This feature refactors the tab management system to improve architecture and user experience. The primary changes include: (1) Renaming TabBindingManager to TabManager and initializing it at the service worker level instead of per-agent, (2) Merging TabGroupManager functionality into TabManager to reduce duplication, (3) Implementing automatic tab assignment when sessions are created, (4) Adding a clickable TabContext UI component with dropdown menu for manual tab selection, and (5) Extracting MessageInput.svelte as an independent component. The technical approach involves singleton pattern refactoring, Chrome Extensions API integration for tab operations, Svelte component restructuring, and comprehensive test updates.

## Technical Context

**Language/Version**: TypeScript 5.9+ with ES2020 target
**Primary Dependencies**: Svelte 4.2, Chrome Extensions API (chrome.tabs, chrome.tabGroups, chrome.windows), Vite 5.4 (build tool)
**Storage**: Chrome Extension service worker state (in-memory), SessionState persistence (existing mechanism)
**Testing**: Vitest 3.2 (unit, integration, contract tests), @testing-library/svelte 5.2 (component tests), chrome-mock 0.0.9
**Target Platform**: Chromium-based browsers (Chrome, Edge, Brave) as Chrome Extension Manifest V3
**Project Type**: Chrome Extension (browser extension architecture with service worker + sidepanel UI)
**Performance Goals**: Session binding <100ms (SC-001), Tab creation <500ms (SC-002), Tab selection menu render <200ms (SC-006), Tab closure detection <100ms (SC-008), Conflict resolution <50ms (SC-009)
**Constraints**: Chrome Extensions API limitations, service worker lifecycle management, singleton pattern across extension contexts, tab group API availability
**Scale/Scope**: Single extension with ~30 source files affected (core/, sidepanel/, tools/), ~360 lines merged from TabGroupManager, ~15 test files to update

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Status**: ✅ PASS (Constitution template is placeholder - no project-specific gates defined)

Since the constitution file contains only template placeholders, no specific architectural principles or constraints are enforced. This refactoring follows standard Chrome Extension development practices:
- Maintains existing test structure (unit/, integration/, contract/)
- Uses TypeScript with strict type checking
- Preserves singleton pattern for cross-context state management
- Keeps component modularity principles

**Re-evaluation after Phase 1**: Will verify that the refactored TabManager maintains testability, the Svelte components follow existing UI patterns, and performance targets are achievable.

## Project Structure

### Documentation (this feature)

```text
specs/001-tab-manager/
├── spec.md              # Feature specification (completed)
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── tab-manager-api.md
└── checklists/
    └── requirements.md  # Validation checklist (completed)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── TabBindingManager.ts → TabManager.ts  # RENAME + merge TabGroupManager
│   ├── BrowserxAgent.ts                      # UPDATE: remove initialization logic
│   ├── Session.ts                            # UPDATE: add active tab detection
│   └── TurnContext.ts                        # UPDATE: tab creation hook
│
├── sidepanel/
│   ├── components/
│   │   ├── TerminalInput.svelte              # SPLIT into MessageInput.svelte
│   │   ├── MessageInput.svelte               # NEW: extracted component
│   │   └── TabContext.svelte                 # UPDATE: add click + dropdown
│   └── App.svelte                            # UPDATE: use MessageInput
│
├── tools/
│   ├── tab/
│   │   ├── TabGroupManager.ts                # DELETE (merge into TabManager)
│   │   └── TabTool.ts                        # UPDATE: conditionally register
│   ├── ToolRegistry.ts                       # UPDATE: exclude TabTool
│   └── BaseTool.ts                           # No changes
│
├── background/
│   └── service-worker.ts                     # UPDATE: initialize TabManager
│
└── types/
    └── session.ts                            # UPDATE: TabManager types

tests/
├── unit/
│   ├── TabBindingManager.test.ts → TabManager.test.ts  # RENAME + UPDATE
│   └── TabGroupManager.test.ts               # DELETE (merge tests)
│
├── integration/
│   ├── session-tab-lifecycle.test.ts         # UPDATE: new auto-assignment
│   ├── tab-context-display.test.ts           # UPDATE: dropdown interaction
│   └── tab-closure-detection.test.ts         # UPDATE: TabManager ref
│
└── contract/
    └── tab-binding.contract.test.ts          # UPDATE: TabManager contract
```

**Structure Decision**: Chrome Extension architecture with single TypeScript/Svelte codebase. Files organized by layer (core/ for business logic, sidepanel/ for UI, background/ for service worker, tools/ for agent capabilities). Tests mirror source structure with unit/, integration/, and contract/ directories. This refactoring touches ~30 files across core, UI, and test layers.

## Complexity Tracking

**No violations** - Constitution Check passed without complexity concerns.
