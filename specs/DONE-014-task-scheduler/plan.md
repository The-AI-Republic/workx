# Implementation Plan: Task Scheduler Queue System

**Branch**: `014-task-scheduler` | **Date**: 2026-02-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-task-scheduler/spec.md`

## Summary

Implement a task scheduler that allows users to queue AI tasks for automatic sequential execution. Users schedule tasks via long-press on the send button, view/manage tasks via a new Scheduler button in the footer, and each scheduled task runs in its own isolated session. The scheduler uses Chrome's `chrome.alarms` API for persistent timing and IndexedDB for state persistence.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (target: ES2020)
**Primary Dependencies**: Svelte 4.2.20, Chrome Extension APIs (Manifest V3), Vite 5.4.20
**Storage**: IndexedDB (via existing `IndexedDBAdapter`), chrome.storage.local (for scheduler state)
**Testing**: Vitest 3.2.4 (unit: `.test.ts`, integration: `.integration.test.ts`)
**Target Platform**: Chrome Extension (Manifest V3 service worker)
**Project Type**: Chrome Extension (background service worker + sidepanel UI)
**Performance Goals**: Task execution within 5 seconds of scheduled time, sub-second UI interactions
**Constraints**: Service worker 5-minute execution limit, MV3 alarm API for persistent scheduling
**Scale/Scope**: 20+ sequential tasks, persistent across browser restarts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution template is not filled in for this project. Proceeding with standard best practices:

- [x] **Test-First**: Unit tests for scheduler core logic, integration tests for alarm→execution flow
- [x] **Simplicity**: Leverage existing Session, IndexedDB, and alarm patterns rather than new abstractions
- [x] **Observability**: Use existing logging patterns; add scheduler-specific events

## Project Structure

### Documentation (this feature)

```text
specs/014-task-scheduler/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (via /rr.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── scheduler/
│   │   ├── Scheduler.ts              # Main scheduler class
│   │   ├── SchedulerTask.ts          # Task entity
│   │   ├── SchedulerStorage.ts       # IndexedDB persistence
│   │   └── __tests__/
│   │       ├── Scheduler.test.ts
│   │       └── SchedulerStorage.test.ts
│   └── Session.ts                    # Existing (minor modifications)
├── background/
│   ├── service-worker.ts             # Existing (add alarm handlers)
│   └── scheduler-alarms.ts           # Alarm management
├── sidepanel/
│   ├── components/
│   │   ├── layout/
│   │   │   └── FooterBar.svelte      # Existing (add Scheduler button)
│   │   ├── scheduler/
│   │   │   ├── SchedulerButton.svelte
│   │   │   ├── SchedulerPopup.svelte
│   │   │   ├── SchedulerTaskItem.svelte
│   │   │   ├── ScheduleTaskModal.svelte
│   │   │   └── ArchivedTasksView.svelte
│   │   └── MessageInput.svelte       # Existing (add long-press)
│   └── pages/
│       └── chat/
│           └── Main.svelte           # Existing (integrate scheduler)
├── storage/
│   └── IndexedDBAdapter.ts           # Existing (add scheduler_tasks store)
└── models/
    └── types/
        └── Scheduler.ts              # Type definitions

tests/
├── integration/
│   └── scheduler/
│       └── Scheduler.integration.test.ts
└── unit/
    └── scheduler/
        └── Scheduler.test.ts
```

**Structure Decision**: Follows existing Chrome extension patterns. New `scheduler/` module under `core/` for business logic, new UI components under `sidepanel/components/scheduler/`, extends existing `IndexedDBAdapter` with new object store.

## Complexity Tracking

> No violations requiring justification. Design follows existing patterns.

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Storage | Extend IndexedDB | Matches existing session/rollout storage pattern |
| Scheduling | chrome.alarms | Only MV3-compliant option for persistent timers |
| Session isolation | New Session per task | Explicit requirement from spec clarification |
| SchedulerTaskQueue | FIFO by createdAt | Simple, predictable execution order for waiting tasks |
