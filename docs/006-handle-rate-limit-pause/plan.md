# Implementation Plan: Rate Limit Pause Handling

**Branch**: `006-handle-rate-limit-pause` | **Date**: 2025-11-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-handle-rate-limit-pause/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Replace the existing retry-based rate limit handling (HTTP 429) with a pause-and-resume mechanism. When the system detects a rate limit error from API providers, it will pause turn execution for a configurable duration (default: 60 seconds), notify the user, and automatically resume after the pause expires. The implementation leverages existing error detection infrastructure (StreamAttemptError, RateLimitError) and extends TurnManager to support paused states with timer-based resumption.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (target: ES2020)
**Primary Dependencies**: Chrome Extension APIs (Manifest V3), Svelte 4.2.20, Vite 5.4.20, Vitest 3.2.4, Zod 3.23.8
**Storage**: Chrome Storage API (chrome.storage.local for config, IndexedDB for session state)
**Testing**: Vitest 3.2.4 with @testing-library/svelte, jsdom, fake-indexeddb, chrome-mock
**Target Platform**: Chrome Extension environment (browser extension context)
**Project Type**: Single project (Chrome extension with background service worker and side panel UI)
**Performance Goals**: <500ms notification latency on rate limit detection, <1s resume accuracy after pause expires, minimal memory overhead for pause state tracking
**Constraints**: Must work in Chrome extension service worker context (no DOM access in background), must preserve turn state across pause/resume, must handle service worker lifecycle (potential hibernation), configuration changes must persist across browser restarts
**Scale/Scope**: Single turn execution flow modification, affects TurnManager core logic (~300 LOC), config system extension (~50 LOC), minimal UI changes for notifications, comprehensive test coverage for pause/resume scenarios

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Status**: No project constitution defined - using standard engineering practices

Since no constitution file exists for this project, standard software engineering practices apply:
- Test-first development with comprehensive unit and integration tests
- Clear separation of concerns (error detection, state management, configuration)
- Backward compatibility with existing error handling infrastructure
- Documentation of all public APIs and configuration options

## Project Structure

### Documentation (this feature)

```
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```
src/
├── core/
│   ├── TurnManager.ts           # MODIFY: Add pause/resume logic
│   └── session/
│       └── state/
│           ├── types.ts         # MODIFY: Add pause state types
│           └── SessionState.ts  # MODIFY: Persist pause state
├── config/
│   ├── types.ts                 # MODIFY: Add rate limit pause config
│   ├── defaults.ts              # MODIFY: Add default pause duration
│   └── validators.ts            # MODIFY: Validate pause config
├── models/
│   ├── ModelClientError.ts      # EXISTING: Already has RateLimitError
│   └── types/
│       └── StreamAttemptError.ts # MODIFY: Change retry behavior for 429
├── protocol/
│   └── events.ts                # MODIFY: Add pause notification events
└── utils/
    └── time.ts                  # NEW: Timer utilities for pause

tests/
├── unit/
│   ├── TurnManager-pause.test.ts      # NEW: Unit tests for pause logic
│   ├── config-validation.test.ts      # NEW: Config validation tests
│   └── pause-timer.test.ts            # NEW: Timer utility tests
├── integration/
│   ├── rate-limit-pause.test.ts       # NEW: End-to-end pause scenarios
│   └── pause-resume-state.test.ts     # NEW: State persistence tests
└── contract/
    └── pause-notification.test.ts     # NEW: Event contract tests
```

**Structure Decision**: Single project structure with Chrome extension architecture. Core pause logic lives in TurnManager (turn execution orchestration), configuration extensions in config/, state management in core/session/state/, and event notifications in protocol/events. Comprehensive test coverage across unit (isolated component tests), integration (pause/resume flows), and contract (event schema validation) layers.

## Complexity Tracking

*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |

