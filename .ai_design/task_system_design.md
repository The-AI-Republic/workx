# Task Management System Design (Hybrid Approach)

## 1. Overview

Refactor the existing `PlanningTool` from a stateless validator into a persistent task management system. **Single tool, four commands:**

| Command | Purpose |
|---|---|
| `plan` | Bulk-create tasks from a plan (1 call for N tasks) |
| `update` | Update status, fields, or dependencies on a single task |
| `list` | List all session tasks (summary view) |
| `get` | Get full task details by ID |

**Why hybrid instead of 4 separate tools:**
- **Bulk creation**: Creating a 5-step plan is 1 tool call, not 5. Matches the natural "think then plan" LLM flow.
- **Token savings**: 1 tool schema in system prompt (~300 tokens) vs 4 (~1200 tokens). Saves ~900 tokens per conversation.
- **Backward compatibility**: Keeps the `planning_tool` name. Prompt migration is incremental, not a full rewrite.
- **Simpler registration**: 1 tool to register, 1 risk assessor, 1 approval rule, 1 TurnManager check.

**Key properties:**
- Tasks scoped to session, persisted via existing `StorageProvider` interface (IndexedDB on extension, SQLite on desktop — tool code never knows which)
- DAG dependencies via `blockedBy` / `blocks` with cycle detection
- Auto-unblock when blocking tasks complete
- **Fully platform-agnostic** — PlanningTool and TaskStore live in `src/core/` and `src/tools/`, import only from `src/core/storage/` interfaces. Zero `chrome.*` calls, zero platform-specific imports.
- Events emitted through TurnManager → Session → Channel (existing path)

## 2. Data Model

**File: `src/core/taskmanager/types.ts`**

### Storage Blob (one record per session)

```typescript
export interface SessionPlanData {
  sessionId: string;                   // Storage key
  nextTaskId: number;                  // Auto-increment counter (never resets)
  plan_summary?: string;                // What this plan is for
  tasks: Task[];                       // Current plan's tasks
  createdAt: string;                   // When current plan was created (ISO 8601)
  updatedAt: string;                   // Last modification (ISO 8601)
}
```

### Task (within the blob)

```typescript
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface Task {
  id: string;                          // Auto-increment, never resets: "1", "4", "7"
  subject: string;                     // Imperative title ("Fix auth bug")
  task_description: string;            // Detailed requirements
  activeForm?: string;                 // Present continuous ("Fixing auth bug") for UI spinner
  status: TaskStatus;
  owner?: string;                      // Agent name (for future multi-agent)
  metadata?: Record<string, unknown>;  // Arbitrary key-value
  blocks: string[];                    // Task IDs that cannot start until this completes
  blockedBy: string[];                 // Task IDs that must complete before this can start
}

export interface TaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];                 // Only open (non-completed) blocker IDs
}

export type PlanningCommand = 'plan' | 'update' | 'list' | 'get';
```

### Storage strategy

- Single `'tasks'` collection in StorageProvider
- **One record per session**, keyed by `sessionId`
- `storage.get('tasks', sessionId)` → `SessionPlanData`
- `storage.set('tasks', sessionId, blob)` → write entire blob
- `plan` command **replaces** the tasks array (old plan is discarded)
- `nextTaskId` counter **never resets** — prevents stale ID collisions when old task IDs are still in LLM context
- Works with both IndexedDB and SQLite — simple key-value, no queries needed
- Cleanup: session ends → `storage.delete('tasks', sessionId)` removes everything

### Plan replacement example

```
Request 1: "Read my emails"
  plan → tasks: [#1, #2, #3], nextTaskId: 4
  Agent executes, all completed.

Request 2: "Reply to professor"
  plan → tasks: [#4, #5, #6], nextTaskId: 7
  Old tasks #1-#3 are gone. Counter continues from 4.
  If LLM context references stale "taskId: 2" → "task not found" error.
```

## 3. TaskStore Service

**File: `src/core/taskmanager/TaskStore.ts`**

Platform-agnostic service layer. Takes `StorageProvider` in constructor. All operations are read-modify-write on a single blob.

```typescript
export class TaskStore {
  private static readonly COLLECTION = 'tasks';

  constructor(private storage: StorageProvider) {}

  // --- Blob Access ---
  /** Load blob from storage. Returns empty default if no plan exists yet. */
  private async load(sessionId: string): Promise<SessionPlanData>;
  // Default: { sessionId, nextTaskId: 1, tasks: [], createdAt: now, updatedAt: now }

  private async save(data: SessionPlanData): Promise<void>;

  // --- Commands ---

  /** Replace current plan with new tasks. Returns created tasks. */
  async createPlan(sessionId: string, params: {
    plan_summary?: string;
    tasks: Array<{
      subject: string;
      task_description: string;
      activeForm?: string;
    }>;
  }): Promise<{ tasks: Task[]; allTasks: TaskSummary[] }>;

  /** Get a single task by ID from current plan. */
  async get(sessionId: string, taskId: string): Promise<Task | null>;

  /** Update a single task in current plan. */
  async update(sessionId: string, taskId: string, updates: {
    status?: TaskStatus;
    subject?: string;
    task_description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;  // Merged; null value deletes key
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): Promise<{ task: Task; allTasks: TaskSummary[] }>;

  /** List all tasks in current plan. */
  async list(sessionId: string): Promise<TaskSummary[]>;
}
```

**Key behaviors:**

1. **Auto-increment IDs**: `nextTaskId` in blob, never resets. `createPlan()` assigns IDs starting from current counter, increments for each task, saves new counter.

2. **Plan replacement**: `createPlan()` replaces the `tasks` array entirely. Old tasks are gone. Counter continues from where it was.

3. **Metadata merge**: `update()` merges metadata keys (not replaces). Setting a key to `null` deletes it:
   ```typescript
   // Existing: { priority: "high", assignee: "bot" }
   // Update with: { assignee: null, deadline: "tomorrow" }
   // Result: { priority: "high", deadline: "tomorrow" }
   ```

4. **Dependency edges are bidirectional**: `addBlockedBy: ["1"]` on task #2 also adds `blocks: ["2"]` on task #1. Both tasks are in the same blob, so this is a single read-modify-write.

5. **Auto-unblock on completion/deletion**: When task status changes to `completed` or `deleted`, iterate its `blocks` array and remove its ID from each blocked task's `blockedBy` array. All in-memory on the same blob, then one write.

6. **Cycle detection**: BFS from target following `blocks` edges. If we reach the source, reject with error. Runs before adding any edge. O(n) where n = tasks in current plan (typically <20). All in-memory — no extra storage reads.

7. **Atomic consistency**: All dependency updates (bidirectional edges, auto-unblock) happen on the same in-memory blob before a single `save()`. No partial-write risk.

## 4. Tool Schema

**File: `src/tools/PlanningTool.ts`** (refactored in-place)

Single tool with `command` discriminator. All fields present in one schema; validation is command-aware.

```typescript
name: 'planning_tool'
inputSchema: {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['plan', 'update', 'list', 'get'],
      description: 'Operation to perform'
    },

    // --- "plan" command fields ---
    plan_summary: {
      type: 'string',
      description: '[plan] What this plan is for / what changed'
    },
    tasks: {
      type: 'array',
      description: '[plan] Tasks to create. Each becomes a tracked task with an ID.',
      items: {
        type: 'object',
        properties: {
          subject:          { type: 'string', description: 'Imperative title (5-10 words)' },
          task_description: { type: 'string', description: 'Detailed requirements' },
          activeForm:  { type: 'string', description: 'Present continuous form for spinner' }
        },
        required: ['subject', 'task_description']
      }
    },

    // --- "update" command fields ---
    taskId: {
      type: 'string',
      description: '[update, get] Task ID to operate on'
    },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'deleted'],
      description: '[update] New status'
    },
    subject:          { type: 'string', description: '[update] New subject' },
    task_description: { type: 'string', description: '[update] New task_description' },
    activeForm:  { type: 'string', description: '[update] New activeForm' },
    owner:       { type: 'string', description: '[update] Agent name' },
    metadata:    { type: 'object', description: '[update] Merge keys (null deletes)' },
    addBlocks:   { type: 'array', items: { type: 'string' }, description: '[update] Task IDs this blocks' },
    addBlockedBy:{ type: 'array', items: { type: 'string' }, description: '[update] Task IDs blocking this' }
  },
  required: ['command']
}
```

### 4.1 Command: `plan` (bulk create)

**Required fields**: `command`, `tasks`
**Optional fields**: `plan_summary`

```typescript
// LLM sends:
planning_tool({
  command: "plan",
  plan_summary: "Implementation plan for auth feature",
  tasks: [
    { subject: "Add types", task_description: "Create Task interfaces in types.ts", activeForm: "Adding types" },
    { subject: "Implement store", task_description: "Build TaskStore with CRUD", activeForm: "Implementing store" },
    { subject: "Write tests", task_description: "Unit tests for TaskStore", activeForm: "Writing tests" }
  ]
})
```

**Returns to LLM:**
```json
{
  "success": true,
  "message": "Plan created: 3 tasks",
  "taskIds": ["1", "2", "3"],
  "tasks": [
    { "id": "1", "subject": "Add types", "status": "pending", "blockedBy": [] },
    { "id": "2", "subject": "Implement store", "status": "pending", "blockedBy": [] },
    { "id": "3", "subject": "Write tests", "status": "pending", "blockedBy": [] }
  ]
}
```

**Internal `_taskEvent`** (for TurnManager):
```typescript
{
  // ... LLM-facing fields above ...
  _taskEvent: {
    eventType: "plan_created",
    allTasks: [ /* all session tasks as TaskSummary[] */ ]
  }
}
```

**Behavior:**
- **Replaces** the current plan entirely — old tasks are discarded
- Creates all tasks in sequence (auto-increment IDs, counter never resets)
- All tasks start as `pending`
- IDs continue from previous counter (e.g., if old plan had tasks #1-#3, new plan starts at #4) — prevents stale ID collisions
- For minor revisions mid-plan, use `update` on individual tasks instead

### 4.2 Command: `update` (incremental)

**Required fields**: `command`, `taskId`
**Optional fields**: `status`, `subject`, `task_description`, `activeForm`, `owner`, `metadata`, `addBlocks`, `addBlockedBy`

```typescript
// Mark task as in-progress:
planning_tool({ command: "update", taskId: "1", status: "in_progress" })

// Mark task as completed:
planning_tool({ command: "update", taskId: "1", status: "completed" })

// Add dependency:
planning_tool({ command: "update", taskId: "3", addBlockedBy: ["1", "2"] })
```

**Returns to LLM:**
```json
{
  "success": true,
  "taskId": "1",
  "subject": "Add types",
  "status": "completed"
}
```

**Internal `_taskEvent`:**
```typescript
{
  _taskEvent: {
    eventType: "updated" | "completed" | "deleted",  // derived from status change
    task: { id, subject, activeForm, status, blocks, blockedBy },
    allTasks: [ /* all session tasks as TaskSummary[] */ ]
  }
}
```

**`eventType` derivation:**
- Status changed to `completed` → `"completed"`
- Status changed to `deleted` → `"deleted"`
- Any other change → `"updated"`

### 4.3 Command: `list` (read-only)

**Required fields**: `command`

```typescript
planning_tool({ command: "list" })
```

**Returns to LLM:**
```json
{
  "success": true,
  "tasks": [
    { "id": "1", "subject": "Add types", "status": "completed", "blockedBy": [] },
    { "id": "2", "subject": "Implement store", "status": "in_progress", "blockedBy": [] },
    { "id": "3", "subject": "Write tests", "status": "pending", "blockedBy": ["2"] }
  ]
}
```

**No `_taskEvent`** — read-only, no event emission.

### 4.4 Command: `get` (read-only)

**Required fields**: `command`, `taskId`

```typescript
planning_tool({ command: "get", taskId: "2" })
```

**Returns to LLM:** Full task details (id, subject, task_description, activeForm, status, owner, metadata, blocks, blockedBy).

**No `_taskEvent`** — read-only, no event emission.

### 4.5 Validation Rules

| Command | Required | Error if missing |
|---|---|---|
| `plan` | `tasks` (non-empty array) | `"plan command requires a non-empty tasks array"` |
| `update` | `taskId` | `"update command requires taskId"` |
| `list` | *(none)* | — |
| `get` | `taskId` | `"get command requires taskId"` |

Invalid `command` value returns:
```json
{ "success": false, "error": "Invalid command 'foo'. Must be: plan, update, list, get" }
```

## 5. Session ID Injection

Unchanged from original — uses existing `context.sessionId` through `options.metadata.sessionId`.

```typescript
// Existing pattern in src/tools/index.ts — no changes needed:
await registry.register(definition, async (params, context) => {
  return toolInstance.execute(params, {
    metadata: {
      ...context.metadata,
      sessionId: context.sessionId,  // ← already available
      turnId: context.turnId,
      toolName: context.toolName,
    }
  });
}, riskAssessor);
```

Each command reads `options?.metadata?.sessionId` in `executeImpl()`.

## 6. Storage Infrastructure Changes (Core — Platform-Agnostic)

All changes in this section are in `src/core/`. No platform-specific imports. Platform implementations are in Section 6A.

### 6.1 Add 'tasks' collection

**`src/core/storage/types.ts`** — Add `'tasks'` to `CollectionName` union:
```typescript
export type CollectionName =
  | 'conversations' | 'messages' | 'memory'
  | 'settings' | 'cache' | 'credentials'
  | 'tasks';  // ← new
```

### 6.2 Add StorageProvider singleton getter + initializer

**`src/core/storage/index.ts`** — The singleton variable `_storageProvider` and `setStorageProvider()` already exist (lines 33-40). Add the missing getter and initializer, following the existing `getConfigStorage()` / `initializeConfigStorage()` pattern:

```typescript
// Already exists (line 33-40):
let _storageProvider: StorageProvider | null = null;
export function setStorageProvider(provider: StorageProvider): void { ... }

// ADD — getter (mirrors getConfigStorage pattern):
export function getStorageProvider(): StorageProvider {
  if (!_storageProvider) {
    throw new Error('StorageProvider not initialized. Call initializeStorageProvider() first.');
  }
  return _storageProvider;
}

export function isStorageProviderInitialized(): boolean {
  return _storageProvider !== null;
}

// ADD — convenience initializer (mirrors initializeConfigStorage pattern):
export async function initializeStorageProvider(): Promise<void> {
  const provider = await createStorageProvider();
  await provider.initialize();
  setStorageProvider(provider);
}

// ADD — re-export getter:
// (alongside existing getConfigStorage, getCredentialStore exports)
```

This uses the existing `createStorageProvider()` factory (line 56-70) which already branches on `__BUILD_MODE__` to select IndexedDB vs SQLite. No platform-specific imports needed.

### 6.3 TaskStore singleton

**`src/core/taskmanager/index.ts`**:
```typescript
import { TaskStore } from './TaskStore';
import { getStorageProvider } from '../storage';

let _taskStore: TaskStore | null = null;

export function getTaskStore(): TaskStore {
  if (!_taskStore) {
    _taskStore = new TaskStore(getStorageProvider());
  }
  return _taskStore;
}
```

`TaskStore` depends only on the `StorageProvider` interface — never imports from `extension/` or `desktop/`.

## 6A. Platform-Specific Storage Changes

Each platform must register the `'tasks'` collection and call `initializeStorageProvider()` at startup. These changes are outside `src/core/`.

### Extension (Chrome)

**`src/extension/storage/IndexedDBStorageProvider.ts`**:
```typescript
const DB_VERSION = 3;  // was 2
const COLLECTIONS = [..., 'tasks'];
// IndexedDB auto-creates object store on version upgrade
```

**`src/extension/background/service-worker.ts`** — Add to startup initialization:
```typescript
import { initializeStorageProvider } from '../../core/storage';

// In initializeStorage() or equivalent startup function:
await initializeStorageProvider();
// This calls createStorageProvider() → IndexedDBStorageProvider (via __BUILD_MODE__)
```

### Desktop (Apple Pi / Tauri)

**`src/desktop/storage/SQLiteStorageProvider.ts`**:
```typescript
// Add 'tasks' collection support (one record per session, keyed by sessionId)
// The StorageProvider interface handles this as key-value:
//   storage.get('tasks', sessionId) → SessionPlanData blob
//   storage.set('tasks', sessionId, blob) → write
// No special schema needed — uses the same collection pattern as other stores
```

**Desktop startup** (equivalent entry point):
```typescript
import { initializeStorageProvider } from '../../core/storage';

// In app initialization:
await initializeStorageProvider();
// This calls createStorageProvider() → SQLiteStorageProvider (via __BUILD_MODE__)
```

## 7. Event Integration

### 7.1 New event type

**`src/core/protocol/events.ts`**:
```typescript
import type { TaskSummary } from '../taskmanager/types';

export interface TaskUpdateEvent {
  eventType: 'plan_created' | 'updated' | 'completed' | 'deleted';
  task?: {                             // Present for update/completed/deleted
    id: string;
    subject: string;
    activeForm?: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
  };
  allTasks: TaskSummary[];             // Full list for UI rendering (always present)
}

// Add to EventMsg union:
| { type: 'TaskUpdate'; data: TaskUpdateEvent }
```

**Keep existing Plan types** (StepStatus, PlanStepArg, PlanToolArgs) for now — remove in a follow-up PR once all consumers are migrated.

### 7.2 TurnManager changes

**`src/core/TurnManager.ts`** — Replace PlanUpdate emission with TaskUpdate:

```typescript
// BEFORE (lines 831-837):
if (toolName === 'planning_tool' && response.data?._planArgs) {
  await this.emitEvent({ type: 'PlanUpdate', data: response.data._planArgs });
}

// AFTER:
if (toolName === 'planning_tool' && response.data?._taskEvent) {
  await this.emitEvent({ type: 'TaskUpdate', data: response.data._taskEvent });
}
```

Same tool name check (`planning_tool`), different internal field (`_taskEvent` instead of `_planArgs`). Only `plan` and `update` commands attach `_taskEvent`; `list` and `get` don't, so no event is emitted for reads.

### 7.3 UI Changes

**`src/webfront/components/event_display/EventProcessor.ts`**:
- Map `'TaskUpdate'` → `'plan'` category (reuse existing plan rendering slot)
- Process `allTasks` array for full list rendering

**`src/webfront/components/event_display/PlanEvent.svelte`**:
- Update to render task list from `TaskUpdateEvent.allTasks`
- Status markers: ✓ completed, → in_progress (animated), • pending, ✗ deleted
- Show `blockedBy` dependencies inline (e.g., "blocked by #1, #2")
- Show `activeForm` text when in_progress

## 8. Tool Registration

**`src/tools/index.ts`** — Minimal change. Same registration line, just pass TaskStore:

```typescript
// BEFORE:
const planningTool = new PlanningTool();
await registerTool('planning_tool', planningTool, new StaticRiskAssessor(0));

// AFTER:
import { getTaskStore } from '../core/taskmanager';

const planningTool = new PlanningTool(getTaskStore());
await registerTool('planning_tool', planningTool, new StaticRiskAssessor(0));
```

Tool name unchanged. Registration unchanged. Risk level unchanged. Only difference: constructor now takes `TaskStore`.

## 9. PlanningTool Refactoring

**File: `src/tools/PlanningTool.ts`** (refactored in-place)

```typescript
import { BaseTool, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import type { TaskStore } from '../core/taskmanager/TaskStore';
import type { PlanningCommand, TaskSummary } from '../core/taskmanager/types';

export class PlanningTool extends BaseTool {
  constructor(private taskStore: TaskStore) {
    super();
  }

  protected toolDefinition: ToolDefinition = { /* schema from Section 4 */ };

  protected async executeImpl(request: any, options?: BaseToolOptions): Promise<any> {
    const sessionId = options?.metadata?.sessionId;
    if (!sessionId) {
      return { success: false, error: 'No session context' };
    }

    const command: PlanningCommand = request.command;

    switch (command) {
      case 'plan':   return this.executePlan(sessionId, request);
      case 'update': return this.executeUpdate(sessionId, request);
      case 'list':   return this.executeList(sessionId);
      case 'get':    return this.executeGet(sessionId, request);
      default:
        return {
          success: false,
          error: `Invalid command '${command}'. Must be: plan, update, list, get`,
        };
    }
  }

  private async executePlan(sessionId: string, request: any): Promise<any> {
    // Validate tasks array is non-empty
    // taskStore.createPlan(sessionId, { plan_summary, tasks }) — replaces current plan
    // Return taskIds + allTasks + _taskEvent
  }

  private async executeUpdate(sessionId: string, request: any): Promise<any> {
    // Validate taskId present
    // taskStore.update() with provided fields
    // Derive eventType from status change
    // Return updated task + allTasks + _taskEvent
  }

  private async executeList(sessionId: string): Promise<any> {
    // taskStore.listBySession()
    // Return tasks array (no _taskEvent — read-only)
  }

  private async executeGet(sessionId: string, request: any): Promise<any> {
    // Validate taskId present
    // taskStore.get()
    // Return full task details (no _taskEvent — read-only)
  }
}
```

## 10. Agent Prompt Updates

Changes are minimal since the tool name stays `planning_tool`.

**`src/prompts/fragments/pi_tools.md`**:
```markdown
### Task Planning
- Use `planning_tool` with `command: "plan"` for multi-step tasks (3+ steps).
  Provide tasks array with subject (imperative) and task_description.
  Include activeForm (present continuous) for progress display.
- Use `planning_tool` with `command: "update"` to change status:
  set `in_progress` before starting, `completed` when done.
- Use `planning_tool` with `command: "list"` to see all tasks and their status.
- Use `planning_tool` with `command: "get"` to read full task details before starting.
- A new `plan` command replaces the previous plan. Use `update` for mid-plan changes.
```

**`src/prompts/fragments/task_execution_policies.md`**:
```markdown
### Planning Workflow

RESEARCH FIRST:
- Never call `planning_tool` as your first action on a non-trivial task.
- First observe available resources (pages, tools, MCP servers, files).
- Only compose the plan after you have enough context.

PLAN ONCE, UPDATE INCREMENTALLY:
- Call `command: "plan"` once to create all tasks for the current request.
- Mark `in_progress` BEFORE starting a task. Mark `completed` immediately after.
- Only one task should be `in_progress` at a time.
- Use `command: "list"` after completing a task to find the next one.
- A new `plan` call replaces the entire plan — use `update` for mid-plan adjustments.

CONTEXT RECOVERY:
- If you are unsure about the current plan state (e.g., after a long sequence of
  tool calls or when context feels stale), call `planning_tool({ command: "list" })`
  to refresh your understanding before continuing.
- Use `command: "get"` with a specific taskId to retrieve full task_description
  and requirements before starting work on it.
- The plan is persisted in storage — `list` and `get` always return the current
  truth, even if earlier conversation messages have been summarized.

NEW USER REQUEST IN SAME SESSION:
- When the user gives a new request that requires a different plan, create a
  new plan with `command: "plan"`. This replaces the old plan entirely.
- Do not manually delete old tasks — the new `plan` command handles cleanup.
```

**`src/prompts/default_pi_agent_prompt.md`** and **`src/prompts/default_browserx_agent_prompt.md`**:
- Same content as task_execution_policies.md above

## 11. Typical Agent Flow

### Single request

```
1. User: "Implement feature X"

2. Agent researches (reads pages, tools, files)

3. Agent creates plan (1 tool call, N tasks):
   planning_tool({
     command: "plan",
     plan_summary: "Implementation plan for feature X",
     tasks: [
       { subject: "Add types",        task_description: "...", activeForm: "Adding types" },
       { subject: "Implement service", task_description: "...", activeForm: "Implementing service" },
       { subject: "Write tests",       task_description: "...", activeForm: "Writing tests" },
       { subject: "Update prompts",    task_description: "...", activeForm: "Updating prompts" }
     ]
   })
   → Creates tasks #1-#4, UI shows full plan

4. Agent sets up dependencies (1 tool call):
   planning_tool({ command: "update", taskId: "3", addBlockedBy: ["1", "2"] })

5. Agent starts work:
   planning_tool({ command: "update", taskId: "1", status: "in_progress" })
   → UI shows spinner with "Adding types"

6. Agent completes task:
   planning_tool({ command: "update", taskId: "1", status: "completed" })
   → Task #3 auto-unblocked (if #2 also completed)

7. Agent checks what's next:
   planning_tool({ command: "list" })
   → Returns remaining pending tasks

8. Repeat steps 5-7 until all tasks completed
```

### Multiple requests in same session (plan replacement)

```
1. User: "Help me read my email content for today"

2. Agent creates plan:
   planning_tool({ command: "plan", plan_summary: "Read today's emails", tasks: [
     { subject: "Open Gmail",          task_description: "..." },
     { subject: "Read today's emails", task_description: "..." },
     { subject: "Summarize content",   task_description: "..." }
   ]})
   → Creates tasks #1-#3, nextTaskId: 4

3. Agent executes all tasks → #1 ✓, #2 ✓, #3 ✓

4. User: "Now reply to my professor about my research update"

5. Agent creates new plan (replaces old one):
   planning_tool({ command: "plan", plan_summary: "Reply to professor", tasks: [
     { subject: "Find professor's email", task_description: "..." },
     { subject: "Compose reply",          task_description: "..." },
     { subject: "Send email",             task_description: "..." }
   ]})
   → Old tasks #1-#3 discarded
   → Creates tasks #4-#6, nextTaskId: 7
   → UI shows only the new plan

6. Agent: planning_tool({ command: "list" })
   → Returns only #4, #5, #6 (clean slate)
```

## 12. Files to Create

| File | Description |
|---|---|
| `src/core/taskmanager/types.ts` | Task, TaskSummary, TaskStatus, PlanningCommand |
| `src/core/taskmanager/TaskStore.ts` | Storage service with CRUD + dependencies |
| `src/core/taskmanager/index.ts` | Barrel export + getTaskStore() singleton |
| `src/core/taskmanager/__tests__/TaskStore.test.ts` | TaskStore unit tests |
| `src/tools/__tests__/PlanningTool.integration.test.ts` | Integration tests for refactored tool |

## 13. Files to Modify

### Core (platform-agnostic — `src/core/`, `src/tools/`, `src/prompts/`, `src/webfront/`)

| File | Change |
|---|---|
| `src/tools/PlanningTool.ts` | **Refactor**: stateless validator → command-dispatching persistent tool |
| `src/tools/__tests__/PlanningTool.test.ts` | **Rewrite**: test all 4 commands + validation |
| `src/tools/index.ts` | Pass `getTaskStore()` to PlanningTool constructor |
| `src/core/storage/types.ts` | Add `'tasks'` to CollectionName |
| `src/core/storage/index.ts` | Add `getStorageProvider()`, `isStorageProviderInitialized()`, `initializeStorageProvider()` |
| `src/core/protocol/events.ts` | Add TaskUpdateEvent type (keep Plan types temporarily) |
| `src/core/TurnManager.ts` | Change `_planArgs` → `_taskEvent`, `PlanUpdate` → `TaskUpdate` |
| `src/webfront/components/event_display/EventProcessor.ts` | Handle TaskUpdate |
| `src/webfront/components/event_display/PlanEvent.svelte` | Render task list with deps |
| `src/prompts/default_pi_agent_prompt.md` | Update planning_tool usage guidance |
| `src/prompts/default_browserx_agent_prompt.md` | Update planning_tool usage guidance |
| `src/prompts/fragments/task_execution_policies.md` | Update from full-replace to incremental |
| `src/prompts/fragments/pi_tools.md` | Update planning_tool command reference |

### Extension-specific (`src/extension/`)

| File | Change |
|---|---|
| `src/extension/storage/IndexedDBStorageProvider.ts` | Add 'tasks' to COLLECTIONS, bump DB_VERSION→3 |
| `src/extension/background/service-worker.ts` | Call `initializeStorageProvider()` at startup |

### Desktop-specific (`src/desktop/`)

| File | Change |
|---|---|
| `src/desktop/storage/SQLiteStorageProvider.ts` | Add 'tasks' table migration |
| Desktop startup entry point | Call `initializeStorageProvider()` at startup |

## 14. Files to Delete

None. PlanningTool is refactored in-place, not replaced.

## 15. Comparison: Hybrid vs 4-Tool Approach

| Dimension | Hybrid (this design) | 4 Separate Tools |
|---|---|---|
| Tool calls for 5-step plan | **1** | 5 (parallel) |
| System prompt tokens | **~300** | ~1200 |
| Tool name change | **None** (stays `planning_tool`) | 4 new names |
| Prompt migration | **Incremental** (add `command` field) | Full rewrite |
| Schema complexity | Medium (1 polymorphic schema) | **Low** (4 trivial schemas) |
| Files to create | **5** | 10 |
| Files to delete | **0** | 2 |
| Single responsibility | Moderate (1 tool, 4 commands) | **Strong** (1 tool, 1 job) |
| LLM schema comprehension | Good (command discriminator is common) | **Better** (trivial per-tool) |

## 16. Verification

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass (new TaskStore tests + rewritten PlanningTool tests)
3. Grep: zero references to `_planArgs` in TurnManager (replaced by `_taskEvent`)
4. **Platform-agnostic check**: Grep `src/core/taskmanager/` and `src/tools/PlanningTool.ts` for:
   - Zero `chrome.*` calls
   - Zero imports from `src/extension/` or `src/desktop/`
   - Only imports from `src/core/` (StorageProvider interface, types)
5. **Both platforms**: `initializeStorageProvider()` called before any TaskStore access
6. Manual: `plan` → `update` status → verify UI renders task list with dependencies
7. Manual: `list` and `get` return correct data, do not emit events
