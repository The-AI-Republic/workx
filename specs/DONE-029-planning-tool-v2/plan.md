# Implementation Plan: PlanningTool V2

**Branch**: `029-planning-tool-v2` | **Date**: 2026-02-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/029-planning-tool-v2/spec.md`

## Summary

Enhance the existing PlanningTool with persistent storage (IndexedDB), system prompt injection (PromptComposer), enriched step schema (files, reuse, verification, dependencies, activeDescription), enriched tool description (behavioral guidance for the LLM), and improved UI rendering (PlanEvent.svelte). The tool remains non-blocking and purely informational — it tracks agent progress and provides plan context for better task execution continuity.

**Agent guidance approach**: Following the Claude Code pattern, planning behavioral instructions live in the tool description (always visible to the LLM as part of the tool schema), NOT in a separate system prompt section. The PromptComposer only handles injecting the current plan's content — the instructions for when/how to plan are in the tool definition itself.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: uuid (13.0.0), zod (3.23.8), Svelte 4.x (UI components)
**Storage**: IndexedDB (`pi_cache` database, currently DB_VERSION=3, will bump to 4)
**Testing**: Vitest 3.2.4 (jsdom environment, globals enabled)
**Target Platform**: Chrome Extension + Tauri Desktop
**Project Type**: Single project (browser extension with desktop variant)
**Performance Goals**: <200ms plan create-to-display latency (SC-003)
**Constraints**: ≤1000 tokens system prompt injection for 10 enriched steps (SC-004)
**Scale/Scope**: One active plan per session, single-user, in-browser storage

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is unconfigured (template placeholders only). No gates to enforce. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/029-planning-tool-v2/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── internal-api.md  # PlanningTool input/output schema
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── protocol/
│       └── events.ts                  # MODIFY: Extend PlanItemArg, UpdatePlanArgs, StepStatus
├── prompts/
│   └── PromptComposer.ts             # MODIFY: Add plan context injection section
├── storage/
│   ├── IndexedDBAdapter.ts           # MODIFY: Add PLANS store, bump DB_VERSION to 4
│   └── PlanStore.ts                  # NEW: Plan persistence layer (get/put/delete)
├── tools/
│   ├── PlanningTool.ts               # MODIFY: Add persistence, action field, enriched schema
│   └── __tests__/
│       └── PlanningTool.test.ts       # MODIFY: Add tests for persistence, actions, dependencies
├── extension/
│   └── sidepanel/
│       └── components/
│           └── event_display/
│               └── PlanEvent.svelte   # MODIFY: Render enriched steps, spinner, dependencies
└── types/
    └── storage.ts                     # MODIFY: Add Plan and PlanStep storage types
```

**Structure Decision**: Single project structure. This feature modifies existing files across storage, prompts, tools, and UI layers. One new file (`PlanStore.ts`) wraps IndexedDB operations for plan-specific CRUD.

## Complexity Tracking

No constitution violations to justify.
