# Data Model: Token Usage Storage & UI

**Feature**: `038-token-usage-storage-ui`
**Date**: 2026-03-05

## Entities

### TokenUsageRecord (Persisted)

Stored in `token_usage_records` object store. One record per completed/aborted task.

| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `id` | `string` | Unique identifier (`{sessionId}_{taskId}_{timestamp}`) | Generated at write time |
| `sessionId` | `string` | Session that owns this task | `TaskRunner.session.getSessionId()` |
| `taskId` | `string` | Submission/task identifier | `TaskRunner.submissionId` |
| `model` | `string` | LLM model used (e.g., `gpt-4o`, `grok-2`) | `TaskRunner.turnContext.getModel()` |
| `timestamp` | `string` | ISO 8601 datetime of task completion | `new Date().toISOString()` |
| `input_tokens` | `number` | Total input tokens consumed | `TokenUsage.input_tokens` |
| `cached_input_tokens` | `number` | Cached (prompt cache hit) input tokens | `TokenUsage.cached_input_tokens` |
| `output_tokens` | `number` | Output tokens generated | `TokenUsage.output_tokens` |
| `reasoning_output_tokens` | `number` | Reasoning/chain-of-thought output tokens | `TokenUsage.reasoning_output_tokens` |
| `total_tokens` | `number` | Sum of all token fields | `TokenUsage.total_tokens` |
| `turn_count` | `number` | Number of LLM turns in this task | `LoopOutcome.turnCount` |

**Key Path**: `id`
**Indexes**:
- `by_session` → `sessionId` (query all records for a session)
- `by_timestamp` → `timestamp` (range queries for date filtering)
- `by_model` → `model` (filter by LLM model)

### SessionUsageSummary (Runtime-computed)

Not stored. Aggregated from `TokenUsageRecord[]` grouped by `sessionId`.

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session identifier |
| `firstTimestamp` | `string` | Earliest task timestamp in session |
| `lastTimestamp` | `string` | Latest task timestamp in session |
| `models` | `string[]` | Distinct model names used |
| `taskCount` | `number` | Number of tasks in session |
| `input_tokens` | `number` | Sum of input_tokens across tasks |
| `cached_input_tokens` | `number` | Sum of cached_input_tokens |
| `output_tokens` | `number` | Sum of output_tokens |
| `reasoning_output_tokens` | `number` | Sum of reasoning_output_tokens |
| `total_tokens` | `number` | Sum of total_tokens |
| `turn_count` | `number` | Sum of turn_count |

### DailyUsageSummary (Runtime-computed)

Not stored. Aggregated from `TokenUsageRecord[]` grouped by calendar date.

| Field | Type | Description |
|-------|------|-------------|
| `date` | `string` | Calendar date (YYYY-MM-DD) |
| `total_tokens` | `number` | Total tokens for the day |
| `input_tokens` | `number` | Total input tokens for the day |
| `output_tokens` | `number` | Total output tokens for the day |
| `byModel` | `Record<string, number>` | Token count per model |

## Storage Registration

### STORE_KEY_PATHS addition

```typescript
token_usage_records: 'id',
```

### INDEX_FIELD_MAP additions

```typescript
by_session: 'sessionId',      // already exists — shared index name
by_timestamp: 'timestamp',    // already exists — shared index name
by_model: 'model',            // NEW
```

### IndexedDB Schema (version 4)

```javascript
// In onupgradeneeded handler:
if (!db.objectStoreNames.contains('token_usage_records')) {
  const store = db.createObjectStore('token_usage_records', { keyPath: 'id' });
  store.createIndex('by_session', 'sessionId', { unique: false });
  store.createIndex('by_timestamp', 'timestamp', { unique: false });
  store.createIndex('by_model', 'model', { unique: false });
}
```

### SQLite Schema (auto-created by NodeSQLiteAdapter/TauriSQLiteAdapter)

Both SQLite adapters auto-create tables when a new store name is used. The `NodeSQLiteAdapter` creates:
```sql
CREATE TABLE IF NOT EXISTS token_usage_records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_records_sessionId ON token_usage_records(json_extract(value, '$.sessionId'));
CREATE INDEX IF NOT EXISTS idx_token_usage_records_timestamp ON token_usage_records(json_extract(value, '$.timestamp'));
CREATE INDEX IF NOT EXISTS idx_token_usage_records_model ON token_usage_records(json_extract(value, '$.model'));
```
