# Tasks: Token Usage Storage & UI

**Input**: Design documents from `/specs/038-token-usage-storage-ui/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md

**Tests**: Not explicitly requested in feature specification. Test tasks omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/` at repository root (existing monorepo)

---

## Phase 1: Setup

**Purpose**: Install new dependency, define shared types

- [X] T001 Install chart.js npm dependency (`npm install chart.js`)
- [X] T002 [P] Define `TokenUsageRecord`, `SessionUsageSummary`, and `DailyUsageSummary` interfaces in `src/storage/types.ts` (append to existing file, or create if it doesn't exist). `TokenUsageRecord` fields: `id` (string), `sessionId` (string), `taskId` (string), `model` (string), `timestamp` (string, ISO 8601), `input_tokens` (number), `cached_input_tokens` (number), `output_tokens` (number), `reasoning_output_tokens` (number), `total_tokens` (number), `turn_count` (number). `SessionUsageSummary` fields: `sessionId`, `firstTimestamp`, `lastTimestamp`, `models` (string[]), `taskCount`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, `turn_count`. `DailyUsageSummary` fields: `date` (YYYY-MM-DD string), `total_tokens`, `input_tokens`, `output_tokens`, `byModel` (Record<string, number>).

---

## Phase 2: Foundational (Storage Registration)

**Purpose**: Register the new `token_usage_records` store in the StorageAdapter layer so all 3 platform adapters (IndexedDB, Tauri SQLite, Node SQLite) can use it

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Add `token_usage_records: 'id'` to `STORE_KEY_PATHS` and add `by_model: 'model'` to `INDEX_FIELD_MAP` in `src/storage/StorageAdapter.ts`. Note: `by_session` and `by_timestamp` already exist in `INDEX_FIELD_MAP`.
- [X] T004 Bump IndexedDB version from 3 to 4 in `src/storage/IndexedDBAdapter.ts`. In the `onupgradeneeded` handler, add creation of `token_usage_records` object store with `keyPath: 'id'` and three indexes: `by_session` on `sessionId`, `by_timestamp` on `timestamp`, `by_model` on `model` (all `unique: false`). Follow the existing pattern used for `scheduler_jobs` and `agent_sessions` stores.
- [X] T005 Create `TokenUsageStore` service class in `src/storage/TokenUsageStore.ts`. It wraps `StorageAdapter` and exposes: `save(record: TokenUsageRecord): Promise<void>` — calls `adapter.put('token_usage_records', record)` with try/catch logging on failure; `getAll(): Promise<TokenUsageRecord[]>` — calls `adapter.getAll('token_usage_records')`; `getBySession(sessionId: string): Promise<TokenUsageRecord[]>` — calls `adapter.queryByIndex('token_usage_records', 'by_session', sessionId)`; `getByDateRange(start: string, end: string): Promise<TokenUsageRecord[]>` — calls `adapter.queryByIndex('token_usage_records', 'by_timestamp', IDBKeyRange.bound(start, end))`; `getByModel(model: string): Promise<TokenUsageRecord[]>` — calls `adapter.queryByIndex('token_usage_records', 'by_model', model)`. Also include aggregation methods: `aggregateBySession(records: TokenUsageRecord[]): SessionUsageSummary[]` — groups records by sessionId, sums token fields, collects distinct models, sorts by lastTimestamp descending; `aggregateByDate(records: TokenUsageRecord[]): DailyUsageSummary[]` — groups by YYYY-MM-DD extracted from timestamp, sums tokens, builds byModel map, sorts by date ascending; `aggregateByModel(records: TokenUsageRecord[]): Record<string, { total_tokens: number; taskCount: number }>` — groups by model, sums total_tokens and counts tasks. Use lazy singleton pattern for the StorageAdapter (call `createStorageAdapter()` once, cache). The constructor should accept an optional `StorageAdapter` parameter for testability.

### Wiring & Registration

- [X] T006 Add `/usage` route to `src/webfront/App.svelte`: import `Usage` from `./pages/usage/Usage.svelte`, add `'/usage': Usage` to the `routes` object (before the `'*'` catch-all).
- [X] T007 [P] Add "Usage" nav item to `NAV_ITEMS` array in `src/webfront/stores/layoutStore.ts`: `{ id: 'usage', label: 'Usage', route: '/usage', icon: '<svg>...</svg>' }`. Use a bar-chart style SVG icon (24x24, stroke-based, matching the existing icon style). Place it after "Skills" in the array.

**Checkpoint**: Foundation ready — storage layer accepts token_usage_records, route exists, nav item exists

---

## Phase 3: User Story 2 - Persist Token Usage Per Task (Priority: P1)

**Goal**: Automatically persist a `TokenUsageRecord` every time a task completes or aborts, using fire-and-forget writes that never block the conversation flow.

**Independent Test**: Run a single chat task, close and reopen the extension, then verify via the Usage page (or DevTools IndexedDB inspector) that the record exists with correct fields.

### Implementation for User Story 2

- [X] T008 [US2] Modify `TaskRunner.emitTaskComplete()` in `src/core/TaskRunner.ts` to persist token usage. After building the `TaskCompleteEvent` data (around line 453), add a fire-and-forget call: build a `TokenUsageRecord` from `{ id: \`${sessionId}_${submissionId}_${Date.now()}\`, sessionId: this.session.getSessionId(), taskId: this.submissionId, model: this.turnContext.getModel(), timestamp: new Date().toISOString(), ...outcome.tokenUsage.total (or zeros if undefined), turn_count: outcome.turnCount }`, then call `TokenUsageStore.getInstance().save(record).catch(err => console.warn('Token usage save failed:', err))`. Import `TokenUsageStore` from `@/storage/TokenUsageStore`. Only save if `outcome.tokenUsage.total` exists (skip if no tokens were used).
- [X] T009 [US2] Also handle aborted tasks: modify the abort handler in `TaskRunner` (the method that emits `TaskComplete` with `aborted: true`, near the `emitAbortEvent` or equivalent) to persist partial token usage using the same pattern as T008. If `this.taskState.tokenUsageDetail?.total` has data, save it.

**Checkpoint**: Every task completion/abort now persists a TokenUsageRecord. Verify by running a task and checking IndexedDB.

---

## Phase 4: User Story 1 - View Session Usage List (Priority: P1) MVP

**Goal**: Create the Usage page with a session-grouped, chronologically ordered list showing token consumption per session.

**Independent Test**: Run 2-3 chat sessions, navigate to `/usage`, verify each session appears newest-first with correct totals.

### Implementation for User Story 1

- [X] T010 [P] [US1] Create Svelte store in `src/webfront/stores/usageStore.ts`. Export a `usageStore` using the `createXStore()` pattern (see `schedulerStore.ts` for reference). State: `{ records: TokenUsageRecord[], sessionSummaries: SessionUsageSummary[], loading: boolean, error: string | null }`. Methods: `loadAll()` — gets all records from `TokenUsageStore`, computes session summaries via `aggregateBySession()`, updates state; `refresh()` — alias for `loadAll()`. Import types from `@/storage/types` and `TokenUsageStore` from `@/storage/TokenUsageStore`.
- [X] T011 [P] [US1] Create `UsageList.svelte` component in `src/webfront/components/usage/UsageList.svelte`. Props: `summaries: SessionUsageSummary[]`, `theme: string`. Renders a list/table of session summaries ordered by `lastTimestamp` descending. Each row shows: date/time (formatted from `lastTimestamp`), primary model (first in `models` array), task count, total tokens (formatted with `toLocaleString()`), and a breakdown line showing input/output/cached/reasoning. Support both terminal theme (green-on-black, monospace) and modern theme (card-based, clean). Show empty state "No usage data yet" when summaries is empty.
- [X] T012 [US1] Create `Usage.svelte` page in `src/webfront/pages/usage/Usage.svelte`. Follow the pattern of `Scheduler.svelte`: subscribe to `uiTheme` store, wrap content in a themed container. On mount, call `usageStore.loadAll()`. Render `UsageList` component with session summaries from the store. Include a page header "Token Usage" and a refresh button. Wire up loading and error states.

**Checkpoint**: Usage page shows session-level token usage list. MVP is complete.

---

## Phase 5: User Story 3 - Daily Usage Chart (Priority: P2)

**Goal**: Add a Chart.js bar chart to the Usage page showing daily token usage over the last 30 days, with stacked bars by model.

**Independent Test**: Seed 7+ days of usage data, verify the chart renders with correct daily totals and model-colored stacked bars.

### Implementation for User Story 3

- [X] T013 [P] [US3] Extend `usageStore.ts` in `src/webfront/stores/usageStore.ts`: add `dailySummaries: DailyUsageSummary[]` to state. In `loadAll()`, also compute daily summaries via `TokenUsageStore.aggregateByDate(records)` (filtered to last 30 days). Add a `setDateRange(days: number)` method to re-filter.
- [X] T014 [US3] Create `UsageChart.svelte` component in `src/webfront/components/usage/UsageChart.svelte`. Import Chart.js with tree-shaking: `import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js'` and register them. Props: `dailySummaries: DailyUsageSummary[]`, `theme: string`. Create a `<canvas>` element, initialize a stacked bar chart on mount. X-axis: dates (YYYY-MM-DD labels). Y-axis: total tokens. Build one dataset per model from `byModel` maps, each with a distinct color. Update chart data reactively when `dailySummaries` changes. Destroy chart instance on component destroy. Apply theme-appropriate colors (terminal: green/cyan palette; modern: blue/purple palette). Show "No chart data" when summaries is empty.
- [X] T015 [US3] Integrate `UsageChart` into `Usage.svelte` in `src/webfront/pages/usage/Usage.svelte`. Add the chart component above the list. Pass `dailySummaries` from the store and current theme. The chart and list should stack vertically with the chart taking about 300px height.

**Checkpoint**: Usage page now shows both the daily bar chart and the session list.

---

## Phase 6: User Story 4 - Aggregate by Model (Priority: P3)

**Goal**: Allow users to view usage broken down by model with per-model subtotals.

**Independent Test**: Run tasks with 2+ different models, verify model grouping displays correctly on the Usage page.

### Implementation for User Story 4

- [X] T016 [P] [US4] Extend `usageStore.ts` in `src/webfront/stores/usageStore.ts`: add `modelSummaries: Record<string, { total_tokens: number; taskCount: number }>` to state and `groupByModel: boolean` toggle. In `loadAll()`, also compute model summaries via `TokenUsageStore.aggregateByModel(records)`. Add `toggleGroupByModel()` method.
- [X] T017 [US4] Add model grouping to `UsageList.svelte` in `src/webfront/components/usage/UsageList.svelte`. Accept new prop `modelSummaries` and `groupByModel: boolean`. When `groupByModel` is true, show model-level summary cards (model name, total tokens, task count) above or instead of the session list. Add a "Group by Model" toggle button in the list header.

**Checkpoint**: All user stories complete. Usage page supports session list, daily chart, and model grouping.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge case handling, resilience, cleanup

- [X] T018 Add graceful handling for uninitialized StorageAdapter in `src/storage/TokenUsageStore.ts`: if `createStorageAdapter()` hasn't resolved yet when `save()` is called, queue the write and flush after initialization completes. Use a promise-based init guard (lazy init pattern).
- [X] T019 [P] Add empty state illustrations/messages to `Usage.svelte` in `src/webfront/pages/usage/Usage.svelte` for first-time users: show a friendly message when no data exists, with a hint that usage will appear after running tasks.
- [X] T020 Verify the feature works across all build modes: confirm `token_usage_records` store is accessible in extension mode (IndexedDB), desktop mode (Tauri SQLite), and server mode (Node SQLite). The SQLite adapters auto-create tables from `STORE_KEY_PATHS`, so no code changes are needed for them — just verify the store name and key path are recognized.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (types + dependency)
- **US2 - Persist (Phase 3)**: Depends on Phase 2 (needs TokenUsageStore + storage registration)
- **US1 - Session List (Phase 4)**: Depends on Phase 3 (needs stored records to display)
- **US3 - Daily Chart (Phase 5)**: Depends on Phase 4 (extends existing Usage page and store)
- **US4 - Model Grouping (Phase 6)**: Depends on Phase 4 (extends existing Usage page and store)
- **Polish (Phase 7)**: Depends on all user stories

### User Story Dependencies

- **US2 (P1 - Persist)**: Foundation only — no dependency on other stories. Must complete first since US1 needs data.
- **US1 (P1 - Session List)**: Depends on US2 (needs persisted records to display). Creates the Usage page that US3/US4 extend.
- **US3 (P2 - Daily Chart)**: Depends on US1 (adds chart to existing Usage page). Independent of US4.
- **US4 (P3 - Model Grouping)**: Depends on US1 (adds grouping to existing Usage page). Independent of US3.

### Within Each User Story

- Store/service before UI components
- Components before page integration
- Core implementation before polish

### Parallel Opportunities

- T001 and T002 can run in parallel (Phase 1)
- T006 and T007 can run in parallel (Phase 2 wiring)
- T010 and T011 can run in parallel (US1 store and list component)
- T013 and T014 (if T013 finishes first) — T014 depends on store shape from T013
- US3 and US4 can run in parallel after US1 completes (Phase 5 and Phase 6 are independent)
- T016 and T018/T019 can run in parallel (different files)

---

## Parallel Example: User Story 1

```bash
# Launch store and list component in parallel (different files, no dependencies):
Task T010: "Create usageStore in src/webfront/stores/usageStore.ts"
Task T011: "Create UsageList component in src/webfront/components/usage/UsageList.svelte"

# Then integrate into page (depends on T010 + T011):
Task T012: "Create Usage page in src/webfront/pages/usage/Usage.svelte"
```

## Parallel Example: After US1, US3 and US4 can run in parallel

```bash
# Developer A works on US3 (chart):
Task T013 → T014 → T015

# Developer B works on US4 (model grouping):
Task T016 → T017
```

---

## Implementation Strategy

### MVP First (US2 + US1)

1. Complete Phase 1: Setup (install chart.js, define types)
2. Complete Phase 2: Foundational (register store, create TokenUsageStore, wire route + nav)
3. Complete Phase 3: US2 — Persist per task (hook into TaskRunner)
4. Complete Phase 4: US1 — Session usage list (Usage page with list)
5. **STOP and VALIDATE**: Run tasks, navigate to Usage page, verify records appear

### Incremental Delivery

1. Setup + Foundational + US2 + US1 → MVP with working Usage page showing session list
2. Add US3 → Daily chart appears above the list
3. Add US4 → Model grouping toggle added to list
4. Each increment adds value without breaking previous features

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Fire-and-forget pattern for writes: never await in the task execution hot path
- Chart.js imports use tree-shaking: only import BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend
- All aggregation is runtime-only (no materialized views in storage)
- TokenUsageStore uses lazy singleton pattern for StorageAdapter
