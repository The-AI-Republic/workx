# Feature Specification: Token Usage Storage & UI

**Feature Branch**: `038-token-usage-storage-ui`
**Created**: 2026-03-05
**Status**: Draft
**Input**: User description: "Token usage storage and UI — persist per-task token usage records using platform-agnostic StorageAdapter, support runtime aggregation by session/date/model, and create a Usage page with session-ordered list and Chart.js daily usage chart"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Session Usage List (Priority: P1)

As a user, I want to see a chronological list of my token usage grouped by session, so I can understand how many tokens each conversation consumed.

**Why this priority**: This is the core read path. Without stored records and a list view, no other usage feature can function. It also validates the storage layer end-to-end.

**Independent Test**: Can be fully tested by running 2-3 chat sessions, navigating to the Usage page, and verifying each session appears with correct token totals.

**Acceptance Scenarios**:

1. **Given** the user has completed 3 chat sessions with the agent, **When** they navigate to the Usage page, **Then** they see 3 session entries ordered newest-first, each showing session date, model used, total tokens (input + output + cached + reasoning), and turn count.
2. **Given** the user has no prior sessions, **When** they navigate to the Usage page, **Then** they see an empty state message (e.g., "No usage data yet").
3. **Given** a session used multiple models (e.g., switched mid-conversation), **When** viewing that session row, **Then** the primary model is shown and the detail expansion reveals per-model breakdown.

---

### User Story 2 - Persist Token Usage Per Task (Priority: P1)

As a system component, when a task completes, the token usage for that task must be automatically persisted to the storage layer so it survives page reloads and is available for querying.

**Why this priority**: This is the write path — the foundation that all read/aggregation features depend on. Co-equal with P1 since without storage, the list view has no data.

**Independent Test**: Can be tested by running a single task, closing and reopening the extension, then querying storage directly (or via the Usage page) to confirm the record exists with correct fields.

**Acceptance Scenarios**:

1. **Given** a task completes with token usage data, **When** the TaskComplete event fires, **Then** a `token_usage_records` entry is created with: `id`, `sessionId`, `taskId` (submissionId), `model`, `timestamp`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, `turn_count`.
2. **Given** a task is aborted before completion, **When** partial token usage exists, **Then** the partial usage is still persisted (tokens were consumed regardless of outcome).
3. **Given** the storage write fails (e.g., quota exceeded), **When** the task completes, **Then** the failure is logged but does not block the user's conversation flow.

---

### User Story 3 - Daily Usage Chart (Priority: P2)

As a user, I want to see a bar chart of my daily token usage over time, so I can identify trends and high-usage days at a glance.

**Why this priority**: Visual aggregation is valuable but depends on stored data (P1). It's the primary analytical view requested by the user.

**Independent Test**: Can be tested by seeding 7+ days of usage data and verifying the Chart.js bar chart renders correct daily totals with proper date labels on the x-axis.

**Acceptance Scenarios**:

1. **Given** usage records spanning 14 days, **When** the user views the Usage page chart module, **Then** a bar chart displays daily total tokens with date labels, defaulting to the last 30 days.
2. **Given** a day with zero usage, **When** viewing the chart, **Then** that day shows a zero-height bar (no gap in the timeline).
3. **Given** the user has data from multiple models, **When** viewing the chart, **Then** bars are stacked or color-coded by model, with a legend identifying each model.

---

### User Story 4 - Aggregate by Model (Priority: P3)

As a user, I want to filter or view usage broken down by model, so I can compare costs and efficiency across different LLM providers.

**Why this priority**: Adds analytical depth but is not essential for core functionality. Can be delivered incrementally after P1/P2.

**Independent Test**: Can be tested by running tasks with 2+ different models, then verifying model-specific totals on the Usage page.

**Acceptance Scenarios**:

1. **Given** usage records from 3 different models, **When** the user selects "Group by Model" on the Usage page, **Then** the session list groups entries by model with per-model subtotals.

---

### Edge Cases

- What happens when the StorageAdapter is not yet initialized when a task completes? (Queue writes and flush after init.)
- What happens when a single session has 100+ tasks? (Session aggregation must remain performant; read all records for session, aggregate in memory.)
- What happens when storage is cleared/reset? (Usage page shows empty state gracefully.)
- What happens on very first use with no historical data? (Chart shows empty state, list shows "No usage data yet.")

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist a token usage record for every completed or aborted task, containing: record id, session id, submission id, model name, timestamp, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, and turn_count.
- **FR-002**: System MUST use the existing `StorageAdapter` interface (via `createStorageAdapter()`) for all token usage persistence, ensuring platform-agnostic operation across extension, desktop, and server builds.
- **FR-003**: System MUST register a new object store `token_usage_records` with key path `id` and indexes: `by_session` (sessionId), `by_timestamp` (timestamp), `by_model` (model).
- **FR-004**: System MUST provide a `TokenUsageStore` service class that supports: `save(record)`, `getBySession(sessionId)`, `getAll()`, `getByDateRange(start, end)`, `getByModel(model)`, `aggregateBySession()`, `aggregateByDate()`, `aggregateByModel()`.
- **FR-005**: System MUST provide a Usage page accessible from the sidebar navigation, displaying a session-level usage list ordered by most recent first.
- **FR-006**: System MUST render a Chart.js bar chart on the Usage page showing daily token usage for the last 30 days by default.
- **FR-007**: System MUST handle storage write failures gracefully — log the error but never block or crash the task execution flow.
- **FR-008**: Aggregation (by session, date, model) MUST happen at runtime in the application layer, not pre-computed in storage, to keep the storage schema simple and the write path fast.
- **FR-009**: System MUST support both terminal and modern UI themes on the Usage page, consistent with existing page patterns.

### Key Entities

- **TokenUsageRecord**: A single task's token consumption. Key attributes: `id` (unique, auto-generated), `sessionId`, `taskId` (submissionId), `model`, `timestamp` (ISO string), `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, `turn_count`.
- **SessionUsageSummary**: Runtime-computed aggregation of all TokenUsageRecords for a session. Attributes: `sessionId`, `firstTimestamp`, `lastTimestamp`, `models` (set of model names), `totalTokens`, `taskCount`, `breakdown` (per-field totals).
- **DailyUsageSummary**: Runtime-computed aggregation by calendar date. Attributes: `date`, `totalTokens`, `byModel` (map of model -> token count).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every task completion (success or abort) results in a persisted TokenUsageRecord that survives page reload, verifiable by querying storage.
- **SC-002**: The Usage page loads and displays session list within 500ms for up to 1000 stored records.
- **SC-003**: The daily usage chart accurately reflects stored data — totals on the chart match the sum of individual records for each day.
- **SC-004**: The feature works identically across extension, desktop, and server builds (platform-agnostic via StorageAdapter).
- **SC-005**: Storage write failures do not impact task execution — user can continue chatting normally even if usage persistence fails.
