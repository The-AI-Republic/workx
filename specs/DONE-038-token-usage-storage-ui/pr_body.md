## Summary

- **Token Usage Persistence**: Every task completion and abort now persists a `TokenUsageRecord` via fire-and-forget writes that never block conversation flow
- **Storage Layer**: New `token_usage_records` store registered across all 3 platform adapters (IndexedDB v4, Tauri SQLite, Node SQLite) with session, timestamp, and model indexes
- **Usage Page**: New `/usage` route with session-grouped usage list, daily Chart.js stacked bar chart, and model grouping toggle

## Changes

### Storage
- `src/storage/types.ts` — New `TokenUsageRecord`, `SessionUsageSummary`, `DailyUsageSummary` interfaces
- `src/storage/TokenUsageStore.ts` — Lazy singleton service with CRUD + static aggregation methods (bySession, byDate, byModel)
- `src/storage/StorageAdapter.ts` — Added `token_usage_records` to `STORE_KEY_PATHS` and `by_model` to `INDEX_FIELD_MAP`
- `src/storage/IndexedDBAdapter.ts` — DB version 3→4 migration, new store with 3 indexes

### Core
- `src/core/TaskRunner.ts` — `persistTokenUsage()` helper called from `emitTaskComplete()` and abort handler

### UI
- `src/webfront/stores/usageStore.ts` — Svelte store with loadAll, date range filtering, model aggregation, group toggle
- `src/webfront/components/usage/UsageList.svelte` — Session summaries list with model grouping view
- `src/webfront/components/usage/UsageChart.svelte` — Chart.js stacked bar chart (daily usage by model, terminal/modern themes)
- `src/webfront/pages/usage/Usage.svelte` — Full page with chart, list, empty state, loading/error states
- `src/webfront/App.svelte` — Added `/usage` route
- `src/webfront/stores/layoutStore.ts` — Added Usage nav item

## Test plan

- [ ] Run a chat task, verify token usage record appears in IndexedDB `token_usage_records` store
- [ ] Cancel a task mid-execution, verify partial usage is still persisted
- [ ] Navigate to `/usage`, verify session list shows newest-first with correct totals
- [ ] Run tasks across multiple days/models, verify Chart.js bar chart renders correctly
- [ ] Toggle "By Model" button, verify model grouping view displays
- [ ] Verify empty state message shows for fresh installs with no usage data
- [ ] Confirm no regressions on desktop (Tauri) and server (Node) builds

🤖 Generated with [Claude Code](https://claude.com/claude-code)
