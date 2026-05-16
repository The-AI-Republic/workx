# Track 08 Tasks

> **Status (2026-05-14):** Single phase, single PR. EventLog deferred to
> **[#215](https://github.com/The-AI-Republic/browserx/issues/215)**.

See [`design.md`](./design.md) for the architectural rationale, gap analysis, and 2026-05-14 second-pass implementation-readiness notes.

---

## Phase 1: CommandQueue

**Goal:** Replace `RepublicAgentEngine.submissionQueue: Submission[]` with a `CommandQueue<Submission>` so `Interrupt` / `ExecApproval` / `Shutdown` ops jump ahead of queued `Compact` / `AddToHistory` ops. Delete dead `QueueProcessor.ts`.

**Estimated size:** ~150 LOC new, ~350 LOC deleted. Single PR.

**Non-goals for v1:** `engineId` filter, `pendingNotifications` folding, consecutive-prompt batching, `remove(uuid)`, `popAll(filter)`, `recheckCommandQueue`, audit logging, `eventQueue` refactor, tool-call preemption. See design.md → "NOT in v1 scope" for rationale.

### 1.1 Pre-flight audits

- [ ] **Naming collision audit (re-verify on branch).** Run:
  ```bash
  grep -rn "class CommandQueue\|interface CommandQueue\|type CommandQueue\b" src/ --include="*.ts" --include="*.svelte"
  grep -rn "QueuedCommand\b" src/ --include="*.ts"
  grep -rn "QueuePriority\b" src/ --include="*.ts"
  grep -rn "EnqueueOptions\b" src/ --include="*.ts"
  ```
  Expect zero hits. If a collision exists, fall back to `MessageQueue<T>` or `SubmissionQueueV2`.
- [ ] **Dead-code re-verification.** Run:
  ```bash
  grep -rn "from.*QueueProcessor\|import.*QueueProcessor\|SubmissionQueue\b\|EventQueue\b\|PriorityQueue\b" src/ --include="*.ts" | grep -v __tests__
  ```
  Expect zero production hits. (Note: `RepublicAgent.eventQueue` is a different name — that's an instance field, not the `EventQueue` class.)

### 1.2 New primitive

- [ ] Create `src/core/queue/types.ts`:
  ```typescript
  export type QueuePriority = 'now' | 'next' | 'later';
  export interface QueuedCommand<T> {
    readonly uuid: string;
    readonly payload: T;
    readonly priority: QueuePriority;
    readonly enqueuedAt: number;
  }
  export interface EnqueueOptions {
    priority?: QueuePriority;
  }
  ```
  ~25 LOC.

- [ ] Create `src/core/queue/CommandQueue.ts`:
  - [ ] Internal state: `queue: QueuedCommand<T>[]`, `snapshot: ReadonlyArray<QueuedCommand<T>>`, `listeners: Set<(snap: ReadonlyArray<QueuedCommand<T>>) => void>`.
  - [ ] `PRIORITY_ORDER` const: `{ now: 0, next: 1, later: 2 }`.
  - [ ] `enqueue(payload, opts?)`: append `{ uuid: crypto.randomUUID(), payload, priority: opts?.priority ?? 'next', enqueuedAt: Date.now() }`, rebuild snapshot, notify.
  - [ ] `dequeue()`: linear scan, find lowest `PRIORITY_ORDER[priority]` (first-match preserves FIFO within tier), splice + rebuild snapshot + notify. Return `undefined` if empty.
  - [ ] `peek()`: same scan as `dequeue` but non-mutating.
  - [ ] `clear()`: empty array, rebuild snapshot, notify.
  - [ ] `length` getter.
  - [ ] `subscribe(listener)`: add to Set, return unsubscribe.
  - [ ] Rebuild snapshot via `Object.freeze([...queue])` after every mutation.
  - [ ] Notify synchronously inside mutation methods (matches claudy semantics).
  - [ ] No locks, no async — single-threaded JS event loop is sufficient.
  - ~120 LOC.

- [ ] Create `src/core/queue/priorityForOp.ts`:
  ```typescript
  import type { EngineOp } from '../engine/RepublicAgentEngineConfig';
  import type { QueuePriority } from './types';

  export function priorityForOp(op: EngineOp): QueuePriority {
    switch (op.type) {
      case 'Interrupt':
      case 'Shutdown':
      case 'ExecApproval':
      case 'PatchApproval':
        return 'now';
      case 'Compact':
      case 'AddToHistory':
        return 'later';
      default:
        return 'next';  // UserInput, UserTurn, ServiceRequest, ManualCompact, ClearHistory, future ops
    }
  }
  ```
  ~20 LOC.

- [ ] Brief `src/core/queue/README.md` pointing at the design doc (1-2 paragraphs).

### 1.3 RepublicAgentEngine wiring

All line numbers against `agent-improvements` commit `8d2ca945`.

- [ ] In `src/core/engine/RepublicAgentEngine.ts`:
  - [ ] Add imports: `import { CommandQueue } from '../queue/CommandQueue';` and `import { priorityForOp } from '../queue/priorityForOp';`
  - [ ] **Line 27:** Replace `private submissionQueue: Submission[] = [];` with `private submissionQueue = new CommandQueue<Submission>();`
  - [ ] **Line 130** (inside `submitOperation`): Replace `this.submissionQueue.push(submission);` with `this.submissionQueue.enqueue(submission, { priority: priorityForOp(op) });`
  - [ ] **Line 214** (inside `cancel()`): Replace `this.submissionQueue.length = 0;` with `this.submissionQueue.clear();`
  - [ ] **Line 431** (inside `processSubmissionQueue`): `while (this.submissionQueue.length > 0)` — unchanged; CommandQueue exposes `length` getter.
  - [ ] **Line 432:** Replace `const submission = this.submissionQueue.shift()!;` with `const submission = this.submissionQueue.dequeue()!.payload;` (or unpack into two lines for readability).
  - [ ] **Line 602** (inside `Interrupt` handler): Replace `this.submissionQueue.length = 0;` with `this.submissionQueue.clear();`
  - [ ] **Line 820** (inside `dispose()`): Replace `this.submissionQueue.length = 0;` with `this.submissionQueue.clear();`

- [ ] **DO NOT touch:**
  - Line 28 `eventQueue: EngineEvent[]` — out of scope.
  - Line 29 `processingSubmission: boolean` — re-entrancy guard stays.
  - Line 30 `eventWaiters` — separate resolver pattern.
  - Line 44 `pendingNotifications: string[]` — pre-input buffer, not a queue.
  - Lines 299-312 `enqueueSyntheticUserTurn` — unchanged semantics.
  - Lines 318-325 `drainPendingNotificationsInto` — unchanged.
  - Lines 345-358 sub-agent notification injection — unchanged.

### 1.4 Delete dead code

- [ ] Delete `src/core/QueueProcessor.ts` (343 LOC).
- [ ] Delete `src/core/__tests__/QueueProcessor.test.ts`.
- [ ] Run `grep -rn "QueueProcessor\|SubmissionQueue\b\|EventQueue\b\|PriorityQueue\b" src/ --include="*.ts"` — should return zero hits in production code after deletion.

### 1.5 Tests

#### Add — `src/core/queue/__tests__/CommandQueue.test.ts`

- [ ] `enqueue + dequeue returns same payload` (no priority specified).
- [ ] `dequeue returns 'now' before 'next' before 'later'`.
- [ ] `FIFO within tier` — three `'next'` ops dequeued in insertion order.
- [ ] `peek does not mutate` — `peek() === peek()`, `length` unchanged.
- [ ] `peek returns highest priority` — mirrors `dequeue` ordering without removal.
- [ ] `length tracks mutations` — after enqueue / dequeue / clear.
- [ ] `clear empties the queue` — `length === 0` and `dequeue() === undefined` after.
- [ ] `subscribe fires on enqueue` — listener receives snapshot with new item.
- [ ] `subscribe fires on dequeue` — listener receives snapshot without removed item.
- [ ] `subscribe fires on clear` — listener receives empty snapshot.
- [ ] `unsubscribe stops notifications` — returned function removes listener.
- [ ] `snapshot is frozen` — `Object.isFrozen(snapshot) === true`.
- [ ] `default priority is 'next'` — verify when `opts` omitted.

#### Add — `src/core/queue/__tests__/priorityForOp.test.ts`

- [ ] One assertion per op type listed in design.md → "Op-type → priority mapping".
- [ ] Cover the `default` case to ensure unmapped ops fall through to `'next'`.

#### Add — `src/core/engine/__tests__/RepublicAgentEngine.queueOrdering.test.ts`

- [ ] **Integration**: enqueue `UserInput` then `Interrupt`. Assert `Interrupt` is processed first (its handler runs before the `UserInput` handler).
- [ ] **Integration**: enqueue `Compact` (auto), then `UserInput`. Assert `UserInput` is processed first.
- [ ] **Integration**: enqueue two `UserInput` ops back-to-back. Assert FIFO order within `'next'` tier.

#### Update — existing tests

- [ ] **`src/core/engine/__tests__/RepublicAgentEngine.test.ts`**:
  - Verify `submissionQueue.length` getter still works for any existing assertions (it does — `CommandQueue` exposes `length`).
  - Re-run full file; investigate any failures.
- [ ] **`src/tools/AgentTool/__tests__/SubAgentRunner.background.test.ts`**: should pass unchanged. Verify.
- [ ] **`src/tools/AgentTool/__tests__/SubAgentRunner.quietBackground.test.ts`**: should pass unchanged. Verify.

#### CI

- [ ] `npm run lint && npm run type-check && npm test` — all green.
- [ ] Coverage on `src/core/queue/**` ≥ 90%.

### 1.6 Documentation

- [ ] `src/core/queue/README.md`: 1-2 paragraph overview pointing at design.md and noting the explicit non-goals.
- [ ] Consider one-line note in `src/core/engine/README.md` (if exists) about priority semantics and that interrupts are non-preemptive.

---

## Cross-cutting

- [ ] Verify `__BUILD_MODE__` (`extension` / `desktop` / `server`) is respected — `src/core/queue/` is pure TS with no platform imports, should be trivial.
- [ ] No README.md changes needed in `.ai_design/agent_improvements/` — the table row already reflects the narrowed scope.

---

## Deferred (NOT in this track)

| Item | Tracked at | Why not now |
|------|-----------|-------------|
| EventLog (persistent audit) | [#215](https://github.com/The-AI-Republic/browserx/issues/215) | No validated consumer; lighter in-memory alternative noted in the issue. |
| `engineId` filter on dequeue | not tracked | Per-engine queue isolation already prevents cross-agent leaks. |
| Fold `pendingNotifications` into queue | not tracked | Would convert idle sub-agent notifications to their own turns — a real semantic change that shouldn't ride along with a queue refactor. |
| Consecutive-prompt batching | not tracked | Requires `workload` field on `Submission` — separate refactor. |
| `remove(uuid)` / `popAll(filter)` | not tracked | No BrowserX call site needs them in v1. Add when a consumer appears. |
| `recheckCommandQueue()` nudge | not tracked | Useful only for claudy's React `useSyncExternalStore` async-gap pattern. |
| `eventQueue: EngineEvent[]` refactor | not tracked | Different concern (event delivery to waiters), no priority need. |
| Tool-call preemption on `'now'` arrival | not tracked | Would require tool-cancellation plumbing. Not a queue concern. |
| `RepublicAgentEngine.eventWaiters` refactor | not tracked | Separate resolver-Array pattern. |
| MessageBus (former 08d) | inline in design.md | `ChannelManager` + `ServiceRegistry` + `HookDispatcher` + `CommandQueue.subscribe` cover the surface. |
