# Research: PlanningTool V2

**Feature**: 029-planning-tool-v2
**Date**: 2026-02-20

## R1: Plan Persistence Storage Strategy

**Decision**: Use IndexedDB via existing `IndexedDBAdapter`, adding a new `plans` object store at DB_VERSION=4.

**Rationale**: The codebase already uses IndexedDB with a well-established pattern (`STORE_NAMES`, version-guarded `onupgradeneeded`, generic CRUD methods). Adding a new store follows the same pattern used when `agent_sessions` was added at V3. No new dependencies needed.

**Alternatives considered**:
- **localStorage**: Rejected — 5MB limit, no structured queries, synchronous API blocks UI thread.
- **chrome.storage.local**: Rejected — 10MB limit, async but no indexing, would require a different adapter pattern than the rest of the codebase.
- **In-memory only (current)**: Rejected — this is the problem we're solving. Plans lost on tab close.

## R2: System Prompt Injection Point

**Decision**: Add a new section in `PromptComposer.composeMainInstruction()` after task execution policies. The section is conditionally included only when a plan exists.

**Rationale**: The `composeMainInstruction()` method assembles sections into an array and joins them. Adding a conditional section follows the exact same pattern. The plan context should come after task policies so the agent sees execution rules before the plan it's executing against. The `RuntimeContext` interface will be extended with an optional `currentPlan` field so plan data flows through the existing context pipeline.

**Alternatives considered**:
- **base_instructions_override in TurnManager**: Rejected — this is designed for user-provided overrides, not system-generated context. Mixing concerns.
- **Separate system message**: Rejected — would add a third system message to the prompt. The existing pattern puts everything in one composed prompt.
- **Tool result preamble**: Rejected — plan context should persist across turns, not be tied to a specific tool call.

## R3: Step Identity Scheme

**Decision**: Use stable string IDs (UUID v4 via existing `uuid` package) for plan steps, not array indices.

**Rationale**: The `dependsOn` field references other steps. Array indices are fragile — inserting or removing a step shifts all subsequent indices, breaking dependency references. UUIDs are stable regardless of plan mutations. The `uuid` package (v13.0.0) is already a project dependency.

**Alternatives considered**:
- **Array index**: Rejected — breaks when steps are inserted/removed/reordered.
- **Sequential integer IDs**: Acceptable but offers no advantage over UUIDs and requires a counter to manage. UUIDs are simpler.

## R4: DAG Validation Algorithm

**Decision**: Use depth-first search (DFS) cycle detection on plan submission. Simple topological sort with visited/in-stack tracking.

**Rationale**: Plans are small (typically <30 steps). DFS is O(V+E) which is effectively instant for this scale. No external library needed — a 15-line function handles it.

**Alternatives considered**:
- **Kahn's algorithm (BFS)**: Equally valid, slightly more code. No meaningful difference at this scale.
- **External graph library**: Rejected — overkill for <30 nodes. Adding a dependency for this is unnecessary.

## R5: PlanStore Abstraction Layer

**Decision**: Create a thin `PlanStore` class that wraps `IndexedDBAdapter` for plan-specific operations, with in-memory fallback when IndexedDB is unavailable.

**Rationale**: Direct IndexedDB calls scattered through PlanningTool would couple the tool to storage implementation. A dedicated store follows the existing pattern where domain-specific storage logic is separated (e.g., `RolloutRecorder` wraps IndexedDB for conversation rollouts). The in-memory fallback ensures graceful degradation in private browsing mode or when storage quota is exceeded.

**Alternatives considered**:
- **Direct IndexedDBAdapter calls in PlanningTool**: Rejected — mixes tool logic with storage concerns, harder to test, no fallback path.
- **Generic key-value wrapper**: Rejected — plan operations need specific semantics (get current plan for session, replace on create, version counter increment).

## R6: Plan Prompt Injection Format

**Decision**: Inject plan as a structured text block with clear markers, including all metadata fields. Format optimized for LLM comprehension.

**Rationale**: The plan is guidance for the agent. Full metadata (files, reuse, verification) helps the agent execute more accurately. At ~50 tokens per enriched step and typically <15 steps, the total cost is well within the 1000-token budget. A structured format with consistent markers (status icons, indented sub-fields) is more parseable by LLMs than raw JSON.

**Alternatives considered**:
- **JSON injection**: Rejected — consumes more tokens (quotes, braces, commas) and is less readable for the LLM.
- **Condensed/summarized**: Rejected — per clarification, full metadata is required so the agent has complete guidance.

## R7: Agent Planning Behavioral Guidance Location

**Decision**: Place all planning behavioral guidance (when to plan, what metadata to include, when to update statuses) in the `PLANNING_TOOL_DEFINITION.description` field — the tool description visible to the LLM in the tool schema. No separate system prompt section for planning instructions.

**Rationale**: This follows the Claude Code pattern where `EnterPlanMode` and `TaskCreate` tool descriptions contain the behavioral heuristics, not the general system prompt. The tool description is always visible to the LLM as part of the tool schema on every turn. This keeps the general system prompt clean and avoids token waste when planning isn't relevant. The PromptComposer handles only plan *content* injection (the current plan state), not planning *instructions*.

**Alternatives considered**:
- **Dedicated system prompt section in PromptComposer**: Rejected — adds ~200 tokens to every turn whether the agent is planning or not. Tool descriptions are already part of the prompt and are the natural place for tool-specific behavioral guidance.
- **Conditional system reminder (injected only when relevant)**: This is what Claude Code uses for plan mode workflow details. Could be added later if the tool description alone proves insufficient, but starting simple with just the tool description.
- **Separate planning policies prompt fragment**: Rejected — fragments are static and agent-type-specific (`browserxTools` vs `piTools`). Tool description is universal and stays with the tool definition.
