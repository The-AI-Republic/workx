# Quickstart & Verification: PlanningTool V2

**Feature**: 029-planning-tool-v2
**Date**: 2026-02-20

## Prerequisites

- Node.js and npm installed
- Project dependencies installed (`npm install`)
- Chrome browser for extension testing

## Running Tests

```bash
# Run all tests
npm test

# Run PlanningTool tests specifically
npx vitest run src/tools/__tests__/PlanningTool.test.ts

# Run with coverage
npx vitest run --coverage src/tools/__tests__/PlanningTool.test.ts
```

## Verification Scenarios

### Scenario 1: Plan Persistence (Story 1 — P1)

**What to test**: Plans survive sidebar close/reopen.

1. Open the browserx sidebar in Chrome
2. Send a message that triggers the agent to create a plan (e.g., "Plan how to refactor the auth module")
3. Verify the plan appears in the sidebar with status markers
4. Close the sidebar tab
5. Reopen the sidebar
6. Verify the plan is displayed with all step states exactly as they were

**Expected**: Plan is restored from IndexedDB with 100% fidelity.

### Scenario 2: System Prompt Injection (Story 2 — P1)

**What to test**: Agent sees the plan without calling a tool.

1. Create a plan via the agent
2. Send a follow-up message like "What step are you on?"
3. Verify the agent correctly references the current plan state in its response
4. Verify the agent did NOT call `planning_tool` with `resume` action to read the plan — it should already have the plan from the system prompt

**Expected**: Agent references plan from injected context, not from a tool call.

### Scenario 3: Enriched Steps (Story 3 — P2)

**What to test**: Plan steps with metadata render correctly.

1. Trigger the agent to create a plan with file references (e.g., "Plan how to add a new API endpoint, include the files you'll modify")
2. Verify the sidebar displays:
   - File paths below each relevant step
   - Verification descriptions where provided
   - Clean rendering for steps without optional fields (no empty placeholders)

**Expected**: Rich metadata visible in UI; absent metadata causes no visual artifacts.

### Scenario 4: Step Dependencies (Story 4 — P3)

**What to test**: Dependency validation and blocked status.

**Unit test approach** (no UI needed):
```typescript
// Test: Circular dependency rejected
const result = await tool.execute({
  action: 'create',
  plan: [
    { id: 'a', step: 'Step A', status: 'Pending', dependsOn: ['b'] },
    { id: 'b', step: 'Step B', status: 'Pending', dependsOn: ['a'] },
  ]
});
expect(result.success).toBe(false);
expect(result.errorType).toBe('VALIDATION_ERROR');

// Test: Valid dependencies accepted
const result2 = await tool.execute({
  action: 'create',
  plan: [
    { id: 'a', step: 'Step A', status: 'Pending' },
    { id: 'b', step: 'Step B', status: 'Pending', dependsOn: ['a'] },
  ]
});
expect(result2.success).toBe(true);
```

### Scenario 5: Active Description (Story 5 — P3)

**What to test**: Spinner/animation for in-progress steps.

1. Create a plan where one step has `activeDescription: "Analyzing code structure"`
2. Verify the sidebar shows the active description text with a visual indicator (spinner or animation)
3. Update the step to Completed
4. Verify the active description and animation are replaced by the checkmark marker

### Scenario 6: Plan Actions (create / update / resume)

**Unit test approach**:
```typescript
// Test: create replaces existing plan
await tool.execute({ action: 'create', plan: [{ step: 'Old', status: 'Pending' }] });
await tool.execute({ action: 'create', plan: [{ step: 'New', status: 'Pending' }] });
const resumed = await tool.execute({ action: 'resume' });
expect(resumed.plan).toHaveLength(1);
expect(resumed.plan[0].step).toBe('New');

// Test: update modifies in place
await tool.execute({ action: 'create', plan: [
  { id: 'a', step: 'Step A', status: 'Pending' }
]});
await tool.execute({ action: 'update', plan: [
  { id: 'a', step: 'Step A', status: 'Completed' }
]});
const resumed2 = await tool.execute({ action: 'resume' });
expect(resumed2.plan[0].status).toBe('Completed');

// Test: resume with no plan returns null
const empty = await tool.execute({ action: 'resume' });
expect(empty.plan).toBeNull();
```

### Scenario 7: Graceful Degradation

**What to test**: Tool works when IndexedDB is unavailable.

**Unit test approach** (mock IndexedDB as unavailable):
```typescript
// Mock storage failure
vi.spyOn(planStore, 'save').mockRejectedValue(new Error('QuotaExceeded'));

const result = await tool.execute({
  action: 'create',
  plan: [{ step: 'Test step', status: 'Pending' }]
});

expect(result.success).toBe(true);
expect(result.warning).toContain('storage unavailable');
```

## Key Files to Verify After Implementation

| File | What to check |
|------|---------------|
| `src/tools/PlanningTool.ts` | Persistence calls, action handling, DAG validation |
| `src/storage/PlanStore.ts` | CRUD operations, fallback logic |
| `src/storage/IndexedDBAdapter.ts` | New `plans` store, DB_VERSION=4 migration |
| `src/core/protocol/events.ts` | Extended `PlanItemArg`, `UpdatePlanArgs`, new `StepStatus.Blocked` |
| `src/prompts/PromptComposer.ts` | Plan injection section, conditional inclusion |
| `src/extension/sidepanel/components/event_display/PlanEvent.svelte` | Enriched rendering |
| `src/tools/__tests__/PlanningTool.test.ts` | All new test cases pass |
