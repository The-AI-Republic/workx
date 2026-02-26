# Data Model: PlanningTool V2

**Feature**: 029-planning-tool-v2
**Date**: 2026-02-20

## Entities

### Plan

The top-level plan object. One active plan per session.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string (UUID) | Yes | Unique plan identifier |
| sessionId | string | Yes | Session this plan belongs to (maps to `Session.conversationId`) |
| status | PlanStatus | Yes | `active` or `completed` |
| explanation | string | No | Agent's explanation for creating/updating this plan |
| steps | PlanStep[] | Yes | Ordered list of plan steps |
| version | number | Yes | Monotonically increasing counter, incremented on every update |
| createdAt | number | Yes | Unix timestamp (ms) of plan creation |
| updatedAt | number | Yes | Unix timestamp (ms) of last modification |

**Identity**: Keyed by `sessionId` (one plan per session).
**Lifecycle**: Created → Updated (0..N times) → Completed or Replaced.

### PlanStep

An individual step within a plan.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string (UUID) | Yes | Stable identifier for dependency references |
| step | string | Yes | Human-readable step description |
| status | StepStatus | Yes | `Pending`, `InProgress`, `Completed`, or `Blocked` |
| files | string[] | No | Critical file paths relevant to this step |
| reuse | string[] | No | Existing code/functions to leverage (e.g., `src/utils/jwt.ts:verifyToken()`) |
| verification | string | No | How to verify this step succeeded |
| activeDescription | string | No | Present-tense description shown during InProgress (e.g., "Analyzing auth module") |
| dependsOn | string[] | No | IDs of steps that must complete before this step can start |

**Identity**: Each step has a stable UUID. Steps are referenced by ID in `dependsOn`.
**Lifecycle**: Pending → InProgress → Completed. If `dependsOn` has incomplete dependencies, status is `Blocked`.

### UpdatePlanArgs (Tool Input)

The input the agent sends when calling `planning_tool`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| action | PlanAction | Yes | `create`, `update`, or `resume` |
| explanation | string | No | Why the agent is creating/updating the plan |
| plan | PlanStep[] | Conditional | Required for `create` and `update`. Ignored for `resume`. |

## Enums

### PlanStatus

| Value | Description |
|-------|-------------|
| `active` | Plan is currently in use |
| `completed` | All steps are completed |

### StepStatus (extended)

| Value | Description |
|-------|-------------|
| `Pending` | Not yet started |
| `InProgress` | Currently being executed |
| `Completed` | Successfully finished |
| `Blocked` | Cannot start — waiting on dependencies |

### PlanAction

| Value | Description |
|-------|-------------|
| `create` | Create a new plan, replacing any existing plan for the session |
| `update` | Update the current plan (step statuses, add/modify steps) |
| `resume` | Load and return the existing plan from storage without modifying it |

## Relationships

```text
Session (1) ──── (0..1) Plan ──── (1..N) PlanStep
                                          │
                                          └── dependsOn ──→ PlanStep (0..N)
```

- A Session has zero or one active Plan.
- A Plan has one or more PlanSteps.
- A PlanStep may depend on zero or more other PlanSteps (DAG, no cycles).

## Validation Rules

1. **Plan must have at least one step**: `steps.length >= 1`
2. **Step descriptions must be non-empty**: `step.step.length > 0`
3. **Step status must be valid**: Must be a value in the StepStatus enum.
4. **dependsOn references must exist**: Every ID in `dependsOn` must match an `id` in the same plan's `steps` array.
5. **No circular dependencies**: The dependency graph formed by `dependsOn` must be a DAG (validated via DFS cycle detection).
6. **Blocked status consistency**: A step with `status: Blocked` must have at least one incomplete dependency. A step with all dependencies completed cannot be `Blocked`.
7. **Action determines required fields**: `create` and `update` require `plan` array. `resume` ignores `plan` and returns stored plan.

## Storage Schema (IndexedDB)

**Store name**: `plans`
**Key path**: `sessionId`
**Indexes**: None needed (single key lookup by session ID)

```typescript
// Stored record shape
interface StoredPlan {
  id: string;           // Plan UUID
  sessionId: string;    // Primary key
  status: PlanStatus;
  explanation?: string;
  steps: PlanStep[];
  version: number;
  createdAt: number;
  updatedAt: number;
}
```
