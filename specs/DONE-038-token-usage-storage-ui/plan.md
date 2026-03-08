# Implementation Plan: Token Usage Storage & UI

**Branch**: `038-token-usage-storage-ui` | **Date**: 2026-03-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/038-token-usage-storage-ui/spec.md`

## Summary

Persist per-task token usage records to the existing platform-agnostic `StorageAdapter` layer, provide a `TokenUsageStore` service for CRUD + runtime aggregation, and build a Usage page in the Svelte UI with a session-ordered list and a Chart.js daily usage bar chart.

## Technical Context

**Language/Version**: TypeScript 5.x (ES2020 target), Svelte 5 (Svelte 4 syntax via compat)
**Primary Dependencies**: Svelte, svelte-spa-router, Chart.js (new dependency), existing StorageAdapter
**Storage**: StorageAdapter (IndexedDB in extension, SQLite via Tauri in desktop, better-sqlite3 in server) — new `token_usage_records` object store
**Testing**: Vitest with jsdom environment
**Target Platform**: Chrome extension (MV3), Tauri desktop app, Node.js server
**Project Type**: Single project (existing monorepo structure)
**Performance Goals**: Usage page loads <500ms with 1000 records; storage writes <50ms per record
**Constraints**: Must not block task execution flow; must work across all 3 build modes
**Scale/Scope**: Typical user generates ~50-200 records/day; chart covers 30-day window (~1500-6000 records max)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution is a template (not project-specific), so no explicit gates apply. Design follows established codebase conventions:
- Reuse existing `StorageAdapter` — no new storage abstractions
- Reuse existing page/store/routing patterns
- Test with Vitest following existing patterns
- No new build modes or platform-specific code outside existing adapter structure

## Project Structure

### Documentation (this feature)

```text
specs/038-token-usage-storage-ui/
├── plan.md              # This file
├── data-model.md        # Entity definitions and storage schema
└── tasks.md             # Task breakdown (created by /rr.tasks)
```

### Source Code (repository root)

```text
src/
├── storage/
│   ├── StorageAdapter.ts              # MODIFY: Add token_usage_records to STORE_KEY_PATHS, INDEX_FIELD_MAP
│   ├── IndexedDBAdapter.ts            # MODIFY: Add token_usage_records store + indexes (DB version bump)
│   ├── TokenUsageStore.ts             # NEW: Service class for token usage CRUD + aggregation
│   └── types.ts                       # MODIFY (or NEW): TokenUsageRecord type
├── core/
│   └── TaskRunner.ts                  # MODIFY: Call TokenUsageStore.save() in emitTaskComplete()
├── webfront/
│   ├── pages/
│   │   └── usage/
│   │       └── Usage.svelte           # NEW: Usage page with list + chart
│   ├── stores/
│   │   └── usageStore.ts              # NEW: Svelte store for usage data
│   ├── components/
│   │   └── usage/
│   │       ├── UsageList.svelte       # NEW: Session usage list component
│   │       └── UsageChart.svelte      # NEW: Chart.js daily bar chart component
│   └── App.svelte                     # MODIFY: Add /usage route
├── desktop/
│   └── storage/
│       └── TauriSQLiteAdapter.ts      # No change needed (generic store support)
└── server/
    └── storage/
        └── NodeSQLiteAdapter.ts       # No change needed (generic store support)

src/webfront/stores/layoutStore.ts     # MODIFY: Add Usage nav item
```

**Structure Decision**: Follows existing monorepo structure. Storage changes go in `src/storage/`, the service layer in `src/storage/TokenUsageStore.ts` (co-located with StorageAdapter), UI in `src/webfront/pages/usage/` following existing page patterns.

### Key Design Decisions

#### 1. Storage Layer — Extend Existing StorageAdapter

The `StorageAdapter` interface + `createStorageAdapter()` factory already provides platform-agnostic storage. We add a new store `token_usage_records` following the same pattern as `scheduler_jobs` and `agent_sessions`:

- **IndexedDBAdapter**: Bump DB version (3 → 4), create new object store with indexes in `onupgradeneeded`
- **TauriSQLiteAdapter** and **NodeSQLiteAdapter**: Both handle unknown stores dynamically (auto-create tables), so no code changes needed — they just need the store name and key path registered in `STORE_KEY_PATHS`

#### 2. Write Path — Fire-and-Forget from TaskRunner

`TaskRunner.emitTaskComplete()` already has all needed data (token usage, model, sessionId, submissionId, turn count). We add an async `TokenUsageStore.save()` call wrapped in try/catch — failures are logged but never awaited in a blocking fashion.

#### 3. Aggregation — Runtime In-Memory

All aggregation (by session, by date, by model) happens at query time by fetching raw records and reducing in memory. This keeps the write path simple (single put per task) and avoids maintaining materialized views. With the expected data volumes (<10K records), this is well within performance targets.

#### 4. Chart.js — New Dependency

Chart.js will be added as a new npm dependency. The `UsageChart.svelte` component creates a `<canvas>` element and initializes a Chart.js bar chart instance. Chart.js is tree-shakeable; we import only the bar chart + required plugins to minimize bundle size.

#### 5. Navigation — Add to Sidebar

Add a "Usage" entry to `NAV_ITEMS` in `layoutStore.ts` with an appropriate SVG icon, following the same pattern as Chat/Scheduler/Skills.

## Complexity Tracking

> No constitution violations. The design reuses existing patterns throughout.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | — | — |
