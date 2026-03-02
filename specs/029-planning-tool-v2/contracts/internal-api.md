# Internal API Contract: PlanningTool V2

**Feature**: 029-planning-tool-v2
**Date**: 2026-02-20

This is an internal tool API (LLM-to-tool), not a REST/GraphQL API. The contract defines the tool's input schema (what the agent sends) and output schema (what the agent receives).

## Tool Definition

**Name**: `planning_tool`
**Category**: `planning`
**Version**: `2.0.0`

## Tool Description (Behavioral Guidance for LLM)

This description is the primary mechanism for guiding the agent's planning behavior. It is included in the tool schema visible to the LLM on every turn.

```text
Create, update, and manage task plans for tracking progress on complex tasks.

WHEN TO PLAN:
- Create a plan before starting tasks with 3 or more steps.
- Skip planning for simple 1-2 step tasks — execute directly.

HOW TO CREATE A PLAN:
- Use action "create" with a plan array. Each step should have:
  - "step": Clear description (5-10 words)
  - "status": Start all steps as "Pending"
  - "files": File paths you will modify (when known)
  - "reuse": Existing code/functions to leverage (e.g., "src/utils/parser.ts:parseInput()")
  - "verification": How to verify this step succeeded
  - "dependsOn": IDs of steps that must complete first (when applicable)

HOW TO UPDATE A PLAN:
- Use action "update" to change step statuses as you work.
- Set a step to "InProgress" with an "activeDescription" (present tense, e.g., "Analyzing auth module") before starting it.
- Set a step to "Completed" when finished.
- Only one step should be "InProgress" at a time.

HOW TO RESUME A PLAN:
- Use action "resume" to load the stored plan after a session interruption.
- When a plan exists from a previous turn, it is already in your context — you do not need to call resume unless you need the full plan returned.
- Wait for user direction before continuing execution of a resumed plan.

ACTIONS:
- "create": Create a new plan (replaces any existing plan for this session)
- "update": Modify the current plan (step statuses, add/modify steps)
- "resume": Load and return the existing plan from storage
```

## Input Schema (UpdatePlanArgs)

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["create", "update", "resume"],
      "description": "Intent: 'create' replaces any existing plan, 'update' modifies the current plan, 'resume' loads the stored plan without changes"
    },
    "explanation": {
      "type": "string",
      "description": "Optional explanation for why the plan is being created or updated"
    },
    "plan": {
      "type": "array",
      "description": "Ordered list of plan steps. Required for 'create' and 'update' actions. Ignored for 'resume'.",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable unique identifier for this step. Required for 'update', auto-generated for 'create'."
          },
          "step": {
            "type": "string",
            "description": "Human-readable step description (recommended 5-10 words)"
          },
          "status": {
            "type": "string",
            "enum": ["Pending", "InProgress", "Completed", "Blocked"],
            "description": "Current execution state of this step"
          },
          "files": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional file paths critical to this step"
          },
          "reuse": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional existing code/functions to leverage (e.g., 'src/utils/jwt.ts:verifyToken()')"
          },
          "verification": {
            "type": "string",
            "description": "Optional description of how to verify this step succeeded"
          },
          "activeDescription": {
            "type": "string",
            "description": "Optional present-tense phrase shown during InProgress (e.g., 'Analyzing authentication module')"
          },
          "dependsOn": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional IDs of steps that must complete before this step can start"
          }
        },
        "required": ["step", "status"]
      }
    }
  },
  "required": ["action"]
}
```

## Output Schema (PlanToolResult)

### Success Response — create / update

```json
{
  "success": true,
  "message": "Plan created with 5 steps",
  "planId": "uuid-of-plan",
  "version": 1,
  "stepCount": 5,
  "inProgressStep": "Implement authentication" ,
  "completedCount": 0,
  "pendingCount": 4,
  "blockedCount": 1
}
```

### Success Response — resume

```json
{
  "success": true,
  "message": "Plan resumed",
  "planId": "uuid-of-plan",
  "version": 3,
  "explanation": "Original explanation from when plan was created",
  "plan": [
    {
      "id": "step-uuid-1",
      "step": "Set up project structure",
      "status": "Completed",
      "files": ["src/index.ts", "package.json"],
      "verification": "npm run build succeeds"
    },
    {
      "id": "step-uuid-2",
      "step": "Implement core logic",
      "status": "InProgress",
      "activeDescription": "Implementing core logic",
      "files": ["src/core/engine.ts"],
      "reuse": ["src/utils/parser.ts:parseInput()"],
      "dependsOn": ["step-uuid-1"]
    }
  ],
  "stepCount": 2,
  "completedCount": 1,
  "pendingCount": 0,
  "inProgressStep": "Implement core logic"
}
```

### Success Response — resume (no plan exists)

```json
{
  "success": true,
  "message": "No plan exists for this session",
  "planId": null,
  "plan": null
}
```

### Error Response — validation

```json
{
  "success": false,
  "error": "Circular dependency detected: step-uuid-2 → step-uuid-3 → step-uuid-2",
  "errorType": "VALIDATION_ERROR"
}
```

### Error Response — storage (non-fatal)

```json
{
  "success": true,
  "message": "Plan created with 5 steps (storage unavailable, in-memory only)",
  "warning": "IndexedDB unavailable — plan will not persist across sessions",
  "planId": "uuid-of-plan",
  "stepCount": 5
}
```

## Event Contract (PlanUpdate)

Emitted via `chrome.runtime.sendMessage` on every plan create/update.

```typescript
{
  type: 'EVENT',
  payload: {
    id: 'evt_plan_<timestamp>',
    msg: {
      type: 'PlanUpdate',
      data: {
        action: PlanAction,
        explanation?: string,
        plan: PlanStep[],
        planId: string,
        version: number,
        status: PlanStatus
      }
    }
  }
}
```

## Prompt Injection Contract

Injected into system prompt by PromptComposer when a plan exists.

```text
## Current Plan

Explanation: <agent's explanation>

1. [✓] Set up project structure
   files: src/index.ts, package.json
   verification: npm run build succeeds

2. [→] Implement core logic  (Implementing core logic)
   files: src/core/engine.ts
   reuse: src/utils/parser.ts:parseInput()
   depends on: step 1
   verification: Unit tests pass

3. [•] Write tests
   files: tests/core/engine.test.ts
   depends on: step 2

4. [✗] Deploy to staging  (blocked by: step 3)
   verification: Health check endpoint returns 200
```

**Format rules**:
- Status markers: `[✓]` Completed, `[→]` InProgress, `[•]` Pending, `[✗]` Blocked
- ActiveDescription shown in parentheses after InProgress steps
- Blocked reason shown in parentheses after Blocked steps
- Optional fields (files, reuse, verification, depends on) indented under the step, omitted when absent
- Steps numbered sequentially for human readability (IDs are internal)
