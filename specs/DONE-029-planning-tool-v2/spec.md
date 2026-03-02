# Feature Specification: PlanningTool V2

**Feature Branch**: `029-planning-tool-v2`
**Created**: 2026-02-20
**Status**: Done
**Input**: User description: "Improve PlanningTool with persistent plan storage, richer plan schema, task dependencies, plan re-entry/continuity, system prompt injection, and activeForm UX pattern"

> **Implementation Note**: The final implementation was simplified to a stateless
> validate-and-emit pattern. Persistence, DAG dependencies, and action dispatch
> were removed in favor of having the agent send the full plan state on every call.
> The storage infrastructure (IndexedDB `plans` collection, SQLite migration) was
> subsequently cleaned up as orphaned code.

## Clarifications

### Session 2026-02-20

- Q: Should plan approval gate block tool execution until user approves? → A: No. The PlanningTool is a performance/progress tracking tool, not a permission gate. The agent should never be blocked from executing tools based on plan status. No approval gate.
- Q: One active plan per session or multiple concurrent plans? → A: One active plan per session. The plan can be edited (partial update), updated (status changes), or totally rewritten for a new task under the same session. On rewrite, the previous plan is replaced and discarded.
- Q: Should system prompt injection show full plan or a condensed summary? → A: Full plan with all metadata (files, reuse, verification, dependencies). The plan is guidance for the agent — stripping metadata defeats the purpose. Token cost is negligible (~500 tokens for 10 enriched steps).
- Q: On session resume with plan in-progress, should the agent auto-continue? → A: No. Inject plan for context only — agent waits for user input. The user decides whether to continue, modify, or abandon the plan.
- Q: When agent creates a new plan for a new task, what happens to the old plan? → A: Replace it. Old plan is discarded, new plan takes its place. No archiving.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persistent Plans That Survive Session Loss (Priority: P1)

A user asks the agent to plan a multi-step task. The agent creates a plan with 8 steps and begins executing. Midway through (step 4 in progress), the user closes the browser tab. When the user reopens the sidebar and resumes the conversation, the plan is automatically restored — showing steps 1-3 as completed, step 4 as in-progress, and steps 5-8 as pending — without the agent needing to recreate it.

**Why this priority**: Without persistence, every session interruption loses the plan entirely. This is the single biggest gap — no other improvement matters if plans vanish on tab close.

**Independent Test**: Can be fully tested by creating a plan, closing the sidebar, reopening it, and verifying the plan state is intact. Delivers immediate value by eliminating the most common frustration with the current tool.

**Acceptance Scenarios**:

1. **Given** the agent has created a plan with steps in mixed states, **When** the sidebar is closed and reopened within the same session, **Then** the plan is displayed with all step states preserved exactly as they were.
2. **Given** a plan exists from a previous session, **When** the user starts a new conversation in the same session context, **Then** the agent can access and reference the previous plan.
3. **Given** a plan is stored, **When** the agent updates a step status, **Then** the stored plan is updated in place (not duplicated).
4. **Given** a stored plan exists, **When** the agent creates a new plan for a different task, **Then** the previous plan is replaced by the new one.

---

### User Story 2 - Agent Always Knows the Current Plan (Priority: P1)

When the agent begins a new turn (receives a user message), the current plan is automatically included in the system prompt context. The agent can reference the plan without needing to call a tool to read it. The agent knows which steps are done, which is in progress, and what comes next — enabling it to pick up where it left off seamlessly.

**Why this priority**: Tied with persistence — a stored plan is useless if the agent doesn't see it. Together with Story 1, this forms the minimum viable improvement.

**Independent Test**: Can be tested by verifying the system prompt contains the current plan content before the agent's first response in a turn, and that the agent correctly references plan state without calling any read tool.

**Acceptance Scenarios**:

1. **Given** a plan exists in storage, **When** a new turn begins, **Then** the current plan (all steps and statuses) is injected into the system prompt context.
2. **Given** no plan exists in storage, **When** a new turn begins, **Then** no plan section is injected (no empty or placeholder content).
3. **Given** the plan was updated during the previous turn, **When** the next turn begins, **Then** the injected plan reflects the most recent state.
4. **Given** a plan is injected on session resume, **When** the agent receives the first user message, **Then** the agent uses the plan as context only and waits for user direction — it does not auto-resume execution.

---

### User Story 3 - Richer Plan Steps with Context (Priority: P2)

When the agent creates a plan, each step can optionally include critical file references, existing code to reuse, and a verification description. The UI displays these enriched details so the user can see not just "what" will happen but "where" and "how it will be verified." The agent's tool description guides it to include this information.

**Why this priority**: Makes plans actionable and transparent. Users can evaluate the agent's approach and understand the plan's scope at a glance.

**Independent Test**: Can be tested by having the agent create a plan and verifying the UI displays file paths, reuse references, and verification criteria alongside step descriptions.

**Acceptance Scenarios**:

1. **Given** the agent creates a plan step with file references, **When** the plan is displayed, **Then** each referenced file is shown as a navigable element below the step description.
2. **Given** the agent creates a plan step with a verification description, **When** the step is completed, **Then** the verification description is visible so the user knows how to confirm the step succeeded.
3. **Given** the agent creates a plan step without optional fields, **When** the plan is displayed, **Then** the step renders cleanly with just the description and status (no empty placeholders).

---

### User Story 4 - Steps with Dependencies (Priority: P3)

The agent can declare that certain plan steps depend on other steps. The UI visualizes these dependency relationships (e.g., showing which steps are blocked). The agent uses dependency information to determine which steps can run in parallel versus which must be sequential.

**Why this priority**: Enables the agent to express more realistic execution plans, but the flat ordered list works adequately for most use cases. This is an optimization, not a necessity.

**Independent Test**: Can be tested by creating a plan where step 5 depends on steps 3 and 4, verifying step 5 shows as "blocked" until both dependencies are completed, and verifying independent steps show as parallelizable.

**Acceptance Scenarios**:

1. **Given** the agent creates step B that depends on step A, **When** step A is pending, **Then** step B is displayed as blocked and cannot transition to InProgress.
2. **Given** step B depends on steps A and C, **When** step A is completed but step C is pending, **Then** step B remains blocked.
3. **Given** steps A and B have no dependencies on each other, **When** both are pending, **Then** either may transition to InProgress independently.
4. **Given** a circular dependency is specified (A depends on B, B depends on A), **When** the plan is submitted, **Then** a validation error is returned.

---

### User Story 5 - Active Step Description in UI (Priority: P3)

When a step transitions to InProgress, the agent can provide an "active description" — a present-tense phrase describing what is happening right now (e.g., "Analyzing authentication module"). The UI displays this as an animated/spinner element alongside the step, giving the user real-time awareness of current activity.

**Why this priority**: A polish feature that improves perceived responsiveness. Useful but not critical — the existing arrow marker already communicates in-progress status.

**Independent Test**: Can be tested by setting a step to InProgress with an activeDescription, verifying the UI renders the description with an animation indicator, and verifying it disappears when the step transitions to Completed.

**Acceptance Scenarios**:

1. **Given** a step transitions to InProgress with an activeDescription, **When** the plan is displayed, **Then** the active description is shown next to the step with a visual activity indicator.
2. **Given** a step is InProgress without an activeDescription, **When** the plan is displayed, **Then** the standard arrow marker is shown (no empty space or broken UI).
3. **Given** a step transitions from InProgress to Completed, **When** the plan is updated, **Then** the active description and animation are removed, replaced by the checkmark marker.

---

### Edge Cases

- What happens when the agent calls `planning_tool` with an `action` of "update" but no plan exists in storage? The system treats it as a "create" and initializes a new plan.
- What happens when IndexedDB storage is full or unavailable (e.g., private browsing mode)? The tool falls back to in-memory-only operation with a warning, degrading gracefully to current behavior.
- What happens when the agent's context window has compacted and lost the plan details? The system prompt injection ensures the plan is always available regardless of compaction.
- What happens when a plan has 50+ steps? The full plan is still injected into the system prompt. At ~50 tokens per enriched step, a 50-step plan uses ~2500 tokens — still under 2% of a 128k context window.
- What happens when two plan updates arrive in rapid succession (race condition)? The storage layer uses last-write-wins with a version counter to prevent corruption.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist the current plan to storage, keyed by session ID, on every plan create or update.
- **FR-002**: System MUST load the persisted plan from storage when a session is resumed or the sidebar is reopened, and display it in the UI without agent intervention.
- **FR-003**: System MUST inject the current plan into the system prompt context at the start of each agent turn, so the agent can reference plan state without calling a tool.
- **FR-004**: System MUST NOT inject plan content into the system prompt when no plan exists for the current session.
- **FR-005**: System MUST support a plan-level `status` field with values: `active`, `completed`.
- **FR-006**: The plan step schema MUST support optional `files`, `reuse`, `verification`, and `activeDescription` fields in addition to the existing `step` and `status` fields.
- **FR-007**: The plan step schema MUST support an optional `dependsOn` field that references other step identifiers.
- **FR-008**: System MUST validate that `dependsOn` references form a directed acyclic graph (no circular dependencies).
- **FR-009**: System MUST enforce one active plan per session. The agent may edit (partial step updates), update (status changes), or totally rewrite the plan for a new task. The `action` field with values `create`, `update`, `resume` signals the agent's intent. On `create`, the existing plan is replaced.
- **FR-010**: When `action` is `resume`, the system MUST load the existing plan from storage and return it to the agent rather than creating a new one.
- **FR-011**: The UI MUST render optional step fields (files, verification, activeDescription) when present and display cleanly when absent.
- **FR-012**: The UI MUST display a visual activity indicator (spinner or animation) for in-progress steps that have an `activeDescription`.
- **FR-013**: System MUST replace the current plan when the agent creates a new plan with `action: create` and an existing plan is present. The old plan is discarded.
- **FR-014**: When injecting the plan into the system prompt, the system MUST include the full plan with all metadata (steps, statuses, files, reuse, verification, dependencies) so the agent has complete guidance for task execution.
- **FR-015**: The PlanningTool MUST NOT block or gate execution of any other tools. It is purely informational and for progress tracking.
- **FR-016**: The tool description (visible to the LLM in the tool schema) MUST contain behavioral guidance for when to create plans, what metadata to include, when to update step statuses, and how to use the action field. This is the primary mechanism for guiding agent planning behavior — no separate system prompt section is needed for planning instructions.
- **FR-017**: The tool description MUST guide the agent to: (a) create plans before complex tasks with 3 or more steps, (b) include file references, reuse references, and verification descriptions when applicable, (c) set steps to InProgress with an activeDescription before starting work, (d) set steps to Completed when finished, (e) skip planning for simple 1-2 step tasks, and (f) wait for user direction when resuming a session with an existing plan.

### Key Entities

- **Plan**: The top-level plan object. Has a session ID, status (active/completed), explanation, creation timestamp, last-updated timestamp, version counter, and an ordered list of steps.
- **PlanStep**: An individual step within a plan. Has an identifier, description, status (Pending/InProgress/Completed/Blocked), optional file references, optional reuse references, optional verification description, optional active description, and optional dependency references.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Plans survive sidebar close/reopen with 100% state fidelity — all step statuses, descriptions, and metadata are restored exactly as they were.
- **SC-002**: The agent correctly references the current plan state in its first response of a new turn at least 95% of the time, without calling a tool to read the plan.
- **SC-003**: Plan creation-to-display latency (including storage write) remains under 200ms as perceived by the user.
- **SC-004**: System prompt injection adds no more than 1000 tokens for plans with 10 or fewer fully-enriched steps (including all metadata fields).
- **SC-005**: Plans with circular dependencies are rejected 100% of the time with a clear error message.

## Assumptions

- The existing IndexedDB infrastructure (`IndexedDBAdapter` with `pi_cache` database) will be extended with a new object store for plans, following the established patterns.
- The existing `PromptComposer` architecture supports adding a new dynamic section for plan injection without restructuring.
- Plans are scoped to a single session — cross-session plan sharing is out of scope for this feature.
- The agent's system prompt tool description for `planning_tool` will be updated to guide the model toward including richer step metadata (files, verification), but this is guidance, not enforcement — the optional fields remain optional.
- The PlanningTool remains a non-blocking, informational tool. It never gates or restricts the agent's ability to call other tools.
