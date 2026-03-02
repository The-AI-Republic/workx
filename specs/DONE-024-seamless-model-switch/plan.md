# Implementation Plan: Seamless Model Switch

**Branch**: `024-seamless-model-switch` | **Date**: 2026-02-17 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/024-seamless-model-switch/spec.md`

## Summary

Enable LLM model switching without resetting the conversation.
Currently, `BrowserxAgent.handleModelConfigChange()` calls
`session.clearHistory()` and creates a new TurnContext, destroying
all conversation state. The fix: preserve history, create a new
ModelClient for the selected model, and update the existing
TurnContext. Mid-task model switches are deferred — the running task
completes with its original model, and the new model applies on the
next user submission.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (strict mode)
**Primary Dependencies**: Svelte 4, Chrome Extension APIs (MV3)
**Storage**: IndexedDB via RolloutRecorder, chrome.storage
**Testing**: Vitest with jsdom
**Target Platform**: Chrome Extension (Manifest V3)
**Project Type**: Single project (Chrome extension)
**Performance Goals**: Model switch < 2s (SC-003)
**Constraints**: No external backend, browser-runtime only
**Scale/Scope**: Single-user Chrome extension

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Privacy-First | PASS | No new data leaves the browser. History stays in local storage. No new external calls beyond the configured LLM API. |
| II. Browser-Native Architecture | PASS | All changes are within Chrome Extension architecture (service worker, sidepanel UI). No external backend introduced. |
| III. Test-Driven Quality | PASS | Unit tests for modified methods (handleModelConfigChange, TurnContext.setModelClient). Integration test for model-switch-with-history flow. |
| IV. Multi-Model Extensibility | PASS | This feature directly advances this principle — enables provider-agnostic conversation continuity. ResponseItem format remains provider-agnostic. |
| V. Modular Tooling | PASS | No changes to tool implementations. Tools remain self-contained. Tool history in ResponseItem format flows through existing ModelClient translation. |

**Post-design re-check**: All gates still pass. No new dependencies
introduced. No violations requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/024-seamless-model-switch/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── internal-interfaces.md  # Internal TypeScript contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── BrowserxAgent.ts           # MODIFY: handleModelConfigChange()
│   ├── TurnContext.ts             # MODIFY: add setModelClient()
│   ├── TurnManager.ts            # MODIFY: annotate responses with modelKey
│   ├── Session.ts                 # MINOR: no clearHistory on model switch
│   ├── protocol/
│   │   └── types.ts              # MODIFY: add modelKey to ResponseItem
│   └── models/
│       └── ModelClientFactory.ts  # REVIEW: createClientForCurrentModel() usage
├── extension/
│   └── sidepanel/
│       ├── settings/
│       │   └── ModelSettings.svelte  # MODIFY: remove confirm dialog
│       └── pages/
│           └── chat/
│               └── Main.svelte       # MODIFY: add model indicator
└── storage/
    └── rollout/
        └── types.ts              # NO CHANGE: modelKey auto-persisted via ResponseItem

tests/
├── unit/
│   └── core/
│       ├── BrowserxAgent.model-switch.test.ts  # NEW
│       └── TurnContext.test.ts                 # MODIFY: add setModelClient tests
└── integration/
    └── seamless-model-switch.test.ts           # NEW
```

**Structure Decision**: Single project structure. All changes are
within the existing `src/` and `tests/` directories. No new
top-level directories needed.

## Complexity Tracking

No constitution violations. No complexity justification needed.
