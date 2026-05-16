# Track 08: Centralized Message Queue

> **Status (2026-05-14):** Implementation-ready after a second deep-audit pass against claudy + BrowserX code. Single phase, single PR.
>
> EventLog deferred to **[#215](https://github.com/The-AI-Republic/browserx/issues/215)**. MessageBus (former 08d) stays deferred. Earlier 08a primitives (Signal, Mailbox, ApprovalManager refactor) dropped after the first audit found BrowserX equivalents already exist.

---

## What changed from the previous (2026-05-13) draft

The 2026-05-14 implementation-readiness pass simplified the scope further. Four claims in the previous draft were softened or dropped after rereading both codebases:

| Previous claim | Reality after re-audit | Outcome |
|---|---|---|
| "Add `engineId` filter on `dequeue` for sub-agent isolation" | Per-engine queue isolation already prevents cross-agent leaks. Each `RepublicAgentEngine` has its own queue; sub-agent commands never enter a peer's queue. Claudy needs `agentId` because it has *one shared* queue; BrowserX doesn't. | **Dropped from v1** |
| "Fold `pendingNotifications` into the queue" | `pendingNotifications: string[]` is a pre-input buffer (text prepended to the *next* turn's user input via `drainPendingNotificationsInto`). Folding it would convert sub-agent notifications into their own turns — a semantic change worth doing intentionally if ever, not as a queue-refactor side effect. | **Dropped from v1** (the array stays as-is) |
| "Optional consecutive-prompt batching" | Claudy's `canBatchWith` rule requires a `workload` field on every submission. BrowserX `Submission` doesn't carry one. Adding workload is a separate refactor. | **Dropped from v1** |
| "Selective `remove(uuid)` and `popAll(filter)`" | Audit found zero call sites in BrowserX that would use either. `clear()` covers `cancel()` and `Interrupt`. | **Dropped from v1** |

What survives is the **single load-bearing improvement**: priority-aware dequeue on `submissionQueue` so `Interrupt`/`ExecApproval`/`Shutdown` don't wait behind queued `Compact`/`AddToHistory` ops, plus a frozen-snapshot subscribe surface for future observability and the dead-code deletion.

**Net size:** ~150 LOC new, ~350 LOC deleted (down from the previous estimate of ~300 new / ~350 deleted).

---

## Problem

`RepublicAgentEngine.submissionQueue: Submission[]` (`src/core/engine/RepublicAgentEngine.ts:27`) is a plain array drained via `shift()`. Three concrete pains:

### Pain 1 — Interrupt waits behind queued ops

Concrete scenario: user submits 3 chat messages in quick succession (3 `UserInput` ops queued), then hits the interrupt button (1 `Interrupt` op queued). With strict FIFO, the `Interrupt` op waits for the 3 prior `UserInput` ops to process. The interrupt is supposed to *interrupt*; right now it doesn't until the queue drains.

Same applies to `ExecApproval` and `PatchApproval` ops — the user is already blocked waiting for the answer, but their decision could sit behind background `Compact` or `AddToHistory` ops.

### Pain 2 — No observability of queue state

There's no way for UI/devtools to ask "how many ops are queued? what's the next one?" The current `eventQueue` carries post-handle events, not queue-state snapshots. A subscribe surface would unlock at least a small status indicator in the sidepanel without committing to the full EventLog design.

### Pain 3 — Dead `QueueProcessor.ts`

`src/core/QueueProcessor.ts` (343 LOC) defines `PriorityQueue<T>`, `SubmissionQueue extends PriorityQueue<Submission>`, `EventQueue extends PriorityQueue<Event>`, and a `QueueProcessor` orchestrator. **Verified never instantiated in production** (2026-05-14 audit: `grep -rn "from.*QueueProcessor\|import.*QueueProcessor" src/ | grep -v __tests__` returns zero hits). Carrying two competing priority-queue implementations invites future drift; this is the natural moment to remove it.

### Things that are NOT pain points (re-validated 2026-05-14)

- **Sub-agent cross-talk** — already prevented by per-engine queue isolation. Sub-agents have their own `RepublicAgentEngine` instances with their own `submissionQueue`. No filter needed.
- **In-flight tool preemption** — claudy's `'now'` priority is "urgent but cooperative" (subscribers see it and can choose to abort). Adding tool-cancellation plumbing is out of scope.
- **`ApprovalManager` resolver dance** — already audited. Works fine.
- **`eventQueue: EngineEvent[]`** (engine-internal event buffer, `RepublicAgentEngine.ts:28`) — has different semantics (delivery to `eventWaiters`, no priorities). Not touched in this track.

---

## What claudy does and what BrowserX adopts

Mapped from the 2026-05-14 deep-audit probe of `/home/rich/dev/study/claudy/src/utils/messageQueueManager.ts`.

| Claudy mechanism | File:line | BrowserX action |
|---|---|---|
| Linear-scan `dequeue(filter)` with FIFO within priority tier | `messageQueueManager.ts:167-193` | **Port as-is** (drop the filter param; not needed) |
| `PRIORITY_ORDER = { now: 0, next: 1, later: 2 }` | `messageQueueManager.ts:151-155` | **Port as-is** |
| Priority defaults inline in enqueue (`'next'` for `enqueue`, `'later'` for `enqueuePendingNotification`) | `messageQueueManager.ts:128-135, 142-149` | **Adapt:** single `enqueue(payload, { priority? })`, default `'next'`. Op-type → priority mapping handled at call site in `submitOperation`. |
| Frozen `readonly` snapshot rebuilt on every mutation via `Object.freeze([...commandQueue])` | `messageQueueManager.ts:54-61` | **Port as-is**. Useful for future UI subscribers (Svelte store wrap, devtools panel). |
| `peek(filter?)` — priority-aware, non-mutating | `messageQueueManager.ts:219-238` | **Port as-is** (drop filter param; trivial inclusion in v1) |
| `subscribe(listener)` returns unsubscribe; sync notify on every mutation | `messageQueueManager.ts:71`, `signal.ts` | **Port as-is**. Internal `Set<Listener>` in CommandQueue, not an exported Signal primitive. |
| `remove([cmds])` / `removeByFilter(predicate)` with reverse iteration | `messageQueueManager.ts:273-316` | **Skip in v1**. No BrowserX call site. Reverse-iteration trick documented for future re-introduction. |
| `dequeueAll()` / `dequeueAllMatching(predicate)` | `messageQueueManager.ts:199-213, 244-261` | **Skip in v1**. `clear()` covers BrowserX's `cancel()` + `Interrupt` paths. |
| `canBatchWith` + `joinPromptValues` (consecutive-prompt batching) | `cli/print.ts:443-452, 428-434, 1934-1961` | **Skip in v1**. Requires `workload` field on submissions — separate refactor. |
| `recordQueueOperation` audit logging | `messageQueueManager.ts:28-38` | **Deferred to [#215](https://github.com/The-AI-Republic/browserx/issues/215)**. Phase 1's `subscribe` API is a sufficient seam for future audit. |
| `popAllEditable` (terminal UP-arrow re-edit) | `messageQueueManager.ts:415-484` | **Skip permanently**. Terminal-only UX. |
| `agentId` filter on dequeue (sub-agent isolation) | `messageQueueManager.ts:167-193`, `cli/print.ts:1924` | **Skip permanently**. Per-engine queue isolation in BrowserX already covers this. |
| `QueryGuard` 3-state FSM (idle/dispatching/running) with generation counter | `utils/QueryGuard.ts` | **Skip**. BrowserX's `processingSubmission: boolean` flag is sufficient — re-validated; no async-gap bug observed. |

---

## Phase 1: CommandQueue

### Envelope

```typescript
// src/core/queue/types.ts
export type QueuePriority = 'now' | 'next' | 'later';

export interface QueuedCommand<T> {
  readonly uuid: string;
  readonly payload: T;
  readonly priority: QueuePriority;
  readonly enqueuedAt: number;
}

export interface EnqueueOptions {
  /** Defaults to 'next' if omitted. */
  priority?: QueuePriority;
}
```

No `engineId`, no `workload` fields — neither has a consumer in v1.

### API

```typescript
// src/core/queue/CommandQueue.ts
export class CommandQueue<T> {
  /** Append to queue with given priority; default 'next'. Returns uuid for correlation. */
  enqueue(payload: T, opts?: EnqueueOptions): string;

  /** Remove and return highest-priority item (FIFO within tier). undefined if empty. */
  dequeue(): QueuedCommand<T> | undefined;

  /** Non-destructively return highest-priority item. undefined if empty. */
  peek(): QueuedCommand<T> | undefined;

  /** Empty the queue. */
  clear(): void;

  get length(): number;

  /** Subscribe to mutations. Listener receives frozen snapshot of current queue. */
  subscribe(listener: (snapshot: ReadonlyArray<QueuedCommand<T>>) => void): () => void;
}
```

That's the entire surface — six methods plus a getter. Adding more later is straightforward; cutting later is harder. Per CLAUDE.md ("don't design for hypothetical future requirements"), start minimal.

### Implementation notes

- **Linear scan in `dequeue`/`peek`:** O(n) per call. Queue depth in BrowserX is typically < 5; not worth a heap. Adopt claudy's pattern verbatim.
- **FIFO within priority tier:** First-match semantics during scan — `PRIORITY_ORDER[cmd.priority] < bestPriority`, strictly less-than, preserves insertion order within tier.
- **Frozen snapshot:** `snapshot = Object.freeze([...queue])` on every mutation. Listeners receive the snapshot directly (not a callback to `getSnapshot()`); this is cleaner for non-React consumers than claudy's `useSyncExternalStore` pattern.
- **Sync notification:** subscribers fire synchronously inside `enqueue`/`dequeue`/`clear`. Reentrancy is the caller's responsibility (matches claudy's behavior).
- **No locks:** single-threaded JS event loop serializes mutations. Don't over-engineer.

### Priority semantics

Adopted verbatim from claudy:

- **`'now'`** — pulled before everything else. **Not preemptive**: does not abort an in-flight `await`. The next iteration of the drain loop picks it.
- **`'next'`** — default for ordinary user-driven ops. Drained in FIFO order within tier.
- **`'later'`** — lowest. Drained after `'now'` and `'next'` are exhausted.

### Op-type → priority mapping

Concrete mapping for `RepublicAgentEngineConfig.EngineOp` (every variant covered):

| Op type | Priority | Rationale |
|---|---|---|
| `Interrupt` | `'now'` | User pressed stop; should not wait |
| `Shutdown` | `'now'` | Process teardown; should not wait |
| `ExecApproval` | `'now'` | User already waiting on the tool; their decision unblocks the agent |
| `PatchApproval` | `'now'` | Same as ExecApproval |
| `UserInput` | `'next'` | Foreground typing |
| `UserTurn` | `'next'` | Programmatic foreground submission |
| `ManualCompact` | `'next'` | User triggered `/compact` |
| `ClearHistory` | `'next'` | User triggered |
| `Compact` (auto, mode: 'auto') | `'later'` | Background trimming, no UI wait |
| `AddToHistory` | `'later'` | Side-effect, no user waiting |

Implementation: a small pure helper in the same file:

```typescript
// src/core/queue/priorityForOp.ts (or inline in RepublicAgentEngine.ts)
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
      // UserInput, UserTurn, ManualCompact, ClearHistory, and any future addition
      return 'next';
  }
}
```

`default` returns `'next'` so future Op types get a safe default without compile breaks. Add a unit test that locks the mapping for the listed variants.

---

## NOT in v1 scope (explicit non-goals)

| Item | Why deferred |
|---|---|
| `engineId` filter on dequeue | Per-engine queue isolation already covers it. Re-introduce only if a future feature needs cross-agent queue sharing. |
| Fold `pendingNotifications` into the queue | Would convert idle sub-agent notifications from "prepend to next user input" → "their own synthetic turn". Real behavior change; needs to be decided on its own merits, not bundled with a queue refactor. |
| Consecutive-prompt batching (`canBatchWith` + `joinPromptValues`) | Requires `workload` field on submissions. Adding it is a separate refactor; do it if/when telemetry shows users hit the multi-prompt case often. |
| `remove(uuid)` / `popAll(filter)` | Zero call sites in current BrowserX code. YAGNI. |
| `recheckCommandQueue()` (claudy's "I might have missed something" nudge) | Useful only with claudy's React `useSyncExternalStore` + async-gap design. BrowserX's `processSubmissionQueue` re-checks `length > 0` in its loop; not needed. |
| Audit log via `recordQueueOperation` | Tracked in [#215](https://github.com/The-AI-Republic/browserx/issues/215). Phase 1's `subscribe` surface is the seam if/when it's wired up. |
| `eventQueue: EngineEvent[]` refactor | Different concern (event delivery to waiters), no priority need. Out of scope. |
| Tool-call preemption on `'now'` arrival | Would require deep tool-cancellation plumbing. Not a queue concern. |
| `RepublicAgentEngine.eventWaiters` refactor | Separate resolver-Array pattern; not in scope. |

---

## Migration plan — concrete file edits

All file:line references against the current `agent-improvements` branch as of commit `8d2ca945`.

### New files

1. **`src/core/queue/types.ts`** (~30 LOC) — exports `QueuePriority`, `QueuedCommand<T>`, `EnqueueOptions`.
2. **`src/core/queue/CommandQueue.ts`** (~120 LOC) — the class with linear-scan `dequeue`, frozen snapshot, internal `Set<Listener>`.
3. **`src/core/queue/__tests__/CommandQueue.test.ts`** (~150 LOC) — unit tests; see [Tests](#tests-to-add-and-update) below.

### Edits to `src/core/engine/RepublicAgentEngine.ts`

| Line(s) | Current | Change |
|---|---|---|
| 27 | `private submissionQueue: Submission[] = [];` | `private submissionQueue = new CommandQueue<Submission>();` |
| 130 | `this.submissionQueue.push(submission);` | `this.submissionQueue.enqueue(submission, { priority: priorityForOp(op) });` |
| 214 | `this.submissionQueue.length = 0;` (in `cancel()`) | `this.submissionQueue.clear();` |
| 431 | `while (this.submissionQueue.length > 0) {` (in `processSubmissionQueue`) | `while (this.submissionQueue.length > 0) {` — *unchanged*; CommandQueue exposes `length` getter |
| 432 | `const submission = this.submissionQueue.shift()!;` | `const queued = this.submissionQueue.dequeue()!; const submission = queued.payload;` |
| 602 | `this.submissionQueue.length = 0;` (in `Interrupt` handler) | `this.submissionQueue.clear();` |
| 820 | `this.submissionQueue.length = 0;` (in `dispose`) | `this.submissionQueue.clear();` |

**Untouched** (deliberately):
- Line 28 `eventQueue: EngineEvent[]` — out of scope.
- Line 29 `processingSubmission: boolean` — re-entrancy guard is fine as-is.
- Line 30 `eventWaiters` — separate resolver pattern; out of scope.
- Line 44 `pendingNotifications: string[]` — kept as pre-input buffer.
- Line 299-312 `enqueueSyntheticUserTurn` — kept as-is.
- Line 318-325 `drainPendingNotificationsInto` — kept as-is.

### Delete

- **`src/core/QueueProcessor.ts`** (343 LOC).
- **`src/core/__tests__/QueueProcessor.test.ts`** (test file).

### Type imports

- `RepublicAgentEngine.ts` adds: `import { CommandQueue } from '../queue/CommandQueue';` and `import { priorityForOp } from '../queue/priorityForOp';`.
- No type re-exports needed downstream — `Submission` envelope is unchanged.

---

## Tests to add and update

### Add — `src/core/queue/__tests__/CommandQueue.test.ts`

| Test | Asserts |
|---|---|
| `enqueue + dequeue returns same payload` | Round-trip without priority |
| `dequeue returns 'now' before 'next' before 'later'` | Priority ordering |
| `FIFO within tier` | Three `'next'` ops dequeued in insertion order |
| `peek does not mutate` | `peek() === peek()` |
| `peek returns highest priority` | Mirrors `dequeue` ordering without removal |
| `length tracks mutations` | After enqueue/dequeue/clear |
| `clear empties the queue` | `length === 0` after `clear()` |
| `subscribe fires on enqueue` | Listener receives snapshot with new item |
| `subscribe fires on dequeue` | Listener receives snapshot without the removed item |
| `subscribe fires on clear` | Listener receives empty snapshot |
| `unsubscribe stops further notifications` | Returned function works |
| `snapshot is frozen` | `Object.isFrozen(snapshot)` |
| `snapshot reference changes only on mutation` | Same reference returned across two `length` reads if no mutation between |
| `default priority is 'next'` | Verify default |

### Add — `src/core/queue/__tests__/priorityForOp.test.ts`

Lock the op-type → priority mapping table. One assertion per op type listed above. Ensure new op variants get a compile error or test failure if added without a mapping update.

### Update — `src/core/engine/__tests__/RepublicAgentEngine.test.ts`

Audit (2026-05-14) found these assertions on internal queue state:

| Test | Current assertion | Update |
|---|---|---|
| Around line 167-184 (UserInput submission spawns task) | Spies on `processSubmissionQueue` timing | Verify behavior unchanged; no internal-state assertion |
| Around line 278-319 (Interrupt handler clears queue) | `expect(engine.submissionQueue.length).toBe(0)` (or similar) | Replace with `engine.submissionQueue.length` (CommandQueue still exposes `length`) — should be drop-in |
| Around line 597-602 (`cancel()` resolves pending completions) | Tests `cancel()` behavior via event listeners | Likely unaffected; verify via test run |

Plus: add **one integration test** — submit a `UserInput` op, then `Interrupt`, in that order. Assert the `Interrupt` is processed first (priority 'now' jumps the FIFO).

### Run

```bash
npm run lint && npm run type-check && npm test
```

All green required before merge.

### Notable: no `pendingNotifications` test changes

`pendingNotifications` stays as a `string[]` array. The methods touching it (`enqueueSyntheticUserTurn`, `drainPendingNotificationsInto`) are unchanged. Tests in `/src/tools/AgentTool/__tests__/SubAgentRunner.background.test.ts` and `.quietBackground.test.ts` should pass unchanged.

---

## Naming collision audit (2026-05-14, re-verified)

Run against `src/` on commit `8d2ca945`:

| Symbol | Audit result | Verdict |
|---|---|---|
| `CommandQueue` | No `class`/`interface`/`type` of this name | ✅ safe |
| `QueuedCommand` | No existing | ✅ safe |
| `QueuePriority` | No existing | ✅ safe |
| `EnqueueOptions` | No existing | ✅ safe |
| `SubmissionQueue` | Exists in dead `QueueProcessor.ts` | ✅ safe after deletion — but **don't reuse this name**; the new class has different semantics |
| `EventQueue` | Exists in dead `QueueProcessor.ts` | ✅ same as above; don't reuse |
| `PriorityQueue` | Exists in dead `QueueProcessor.ts` | ✅ safe after deletion |

---

## Edge cases & invariants

Re-validated 2026-05-14 against `RepublicAgentEngine.ts`:

1. **Re-entrancy on `processSubmissionQueue`**: protected by `processingSubmission: boolean` flag (line 29, 428-450). Unchanged — `CommandQueue` doesn't interact with this guard.
2. **Concurrent `submitOperation` from multiple channels**: JavaScript event loop serializes the `.enqueue` calls; the queue itself is single-threaded. Same as today.
3. **`submitOperation` after `cancel()`**: `cancel()` calls `submissionQueue.clear()`. A subsequent `submitOperation` enqueues into the now-empty queue and re-triggers `processSubmissionQueue()`. Same as today.
4. **`Interrupt` clears the queue**: line 602 currently does `submissionQueue.length = 0`. After refactor: `submissionQueue.clear()`. Semantically identical (Interrupt's own op has already been dequeued by the time line 602 runs).
5. **Subscriber callback enqueues during notification**: claudy doesn't guard against this; BrowserX won't either. Document as "caller's responsibility" in the source comment.
6. **`dispose()`**: line 820 currently does `submissionQueue.length = 0`. After refactor: `submissionQueue.clear()`. Same effect.
7. **Empty `dequeue()`**: returns `undefined`. Loop in `processSubmissionQueue` already handles this implicitly via `length > 0` check on line 431; loop exits cleanly.

---

## Dependencies

```
PR #191 (background sub-agents) ──> 08 CommandQueue (no functional change to sub-agent flow,
                                                    but tests must keep passing)

08 CommandQueue ──> #215 EventLog (when triggered — Phase 1's subscribe surface is the seam)
                ──> Deferred 08d MessageBus reassessment (no work expected)
```

No blocking dependencies. Phase 1 ships as a single PR.

---

## Risks

- **Behavior change: `Interrupt` and `ExecApproval` now jump ahead of queued ops.** Could expose latent bugs in handlers that assumed strict FIFO. **Mitigation:** the new integration test (submit `UserInput` then `Interrupt`, verify `Interrupt` is processed first) catches the intended new behavior. If a handler regression appears, it'll surface in CI.
- **Deleting `QueueProcessor.ts` is one-way.** If a stale branch out there imports from it, that branch will fail to merge. **Mitigation:** the audit confirms zero production callers on `agent-improvements`. Open branches are the branch-author's responsibility to rebase. Tracking the deletion in the commit message helps grep.
- **Re-entrant `subscribe` callbacks.** A listener that calls `enqueue` during a notify causes nested notification. Claudy permits this; BrowserX inherits the behavior. **Mitigation:** document in the source as "subscriber's responsibility — avoid mutation during notify or expect nested calls"; no listeners are wired in v1 anyway (the surface is for future use).
- **Linear scan in `dequeue`.** O(n) per call. **Mitigation:** queue depth is typically < 5; not worth a heap. If profiling later shows hot-path issues, switch to bucket-per-priority — trivial migration.

---

## Validation Notes (2026-05-14, second pass)

Two parallel implementation-readiness probes informed this revision. Key concrete findings:

### Claudy queue implementation details (sources)

- **`messageQueueManager.ts`** (`/home/rich/dev/study/claudy/src/utils/messageQueueManager.ts`):
  - Module-level `commandQueue: QueuedCommand[]` (line 53), frozen `snapshot` (line 55), `queueChanged` Signal (line 56).
  - `dequeue(filter)` algorithm: linear scan, FIFO within priority via first-match (lines 167-193).
  - `peek(filter)` mirrors dequeue scan, non-mutating (lines 219-238).
  - `remove` / `removeByFilter` use reverse iteration (lines 273-316).
  - `enqueue` defaults priority `'next'` (line 129); `enqueuePendingNotification` defaults `'later'` (line 143).
  - `PRIORITY_ORDER = { now: 0, next: 1, later: 2 }` (lines 151-155).
  - **No tests file** for `messageQueueManager` — integration-tested via `print.ts` + `query.ts`.
- **`QueuedCommand` schema** (`/home/rich/dev/study/claudy/src/types/textInputTypes.ts:299-358`): 12+ fields including `priority`, `agentId`, `workload`, `uuid`, `mode`, `isMeta`, `origin`.
- **Drain loop** (`cli/print.ts:1934-1961`): `while ((cmd = dequeue(isMainThread)))`; batching via `canBatchWith` + `joinPromptValues` for prompt-mode same-`workload` runs.
- **`canBatchWith`** (`cli/print.ts:443-452`): same `mode === 'prompt'`, same `workload`, same `isMeta`.
- **`joinPromptValues`** (`cli/print.ts:428-434`): newline-joined strings or `flatMap(toBlocks)` for content-block-mixed values.
- **`isMainThread` filter** (`cli/print.ts:1924`): `cmd => cmd.agentId === undefined`. This is the agentId isolation pattern that BrowserX doesn't need.
- **`popAllEditable`** (`messageQueueManager.ts:415-484`): terminal UP-arrow re-edit. Skipped.

### BrowserX integration map (sources)

- **`RepublicAgentEngine`** (`src/core/engine/RepublicAgentEngine.ts`):
  - `submissionQueue: Submission[]` (line 27); ~30 direct references across the file.
  - `eventQueue: EngineEvent[]` (line 28) — separate concern, out of scope.
  - `processingSubmission: boolean` re-entrancy guard (line 29).
  - `pendingNotifications: string[]` (line 44) — pre-input buffer, kept as-is.
  - `submitOperation` (lines 123-133): synchronous push + async `processSubmissionQueue()` trigger.
  - `processSubmissionQueue` (lines 427-452): re-entrancy guarded, `while (length > 0)` loop, `shift()` dequeue, one-at-a-time `handleSubmission`.
  - `Interrupt` handler clears queue at line 602; `cancel()` at line 214; `dispose()` at line 820. All three become `.clear()` calls.
- **`EngineOp` variants** (`src/core/engine/RepublicAgentEngineConfig.ts:176-186`): `UserInput`, `UserTurn`, `Interrupt`, `ExecApproval`, `PatchApproval`, `Compact`, `ManualCompact`, `AddToHistory`, `Shutdown`, `ClearHistory` (10 variants total).
- **`SubAgentRunner.safeEnqueueNotification`** (`src/tools/AgentTool/SubAgentRunner.ts:232-248`): calls `context.parentEngine.enqueueSyntheticUserTurn(text)`. This is the only cross-engine call back to a parent. **Not touched** in v1 because `pendingNotifications` stays as-is.
- **`QueueProcessor.ts`** dead-code re-verification (2026-05-14): zero production imports, zero non-test references. Safe to delete.
- **Naming collisions**: all proposed names (`CommandQueue`, `QueuedCommand`, `QueuePriority`, `EnqueueOptions`) — no existing symbols in `src/`.
- **Tests touching queue state**: `RepublicAgentEngine.test.ts` (multiple), `SubAgentRunner.background.test.ts`, `SubAgentRunner.quietBackground.test.ts`. Most should pass unchanged; explicit `submissionQueue.length` assertions still work via the getter.

### Decisions resolved (2026-05-14, second pass)

1. **Drop `engineId` filter.** Per-engine queue isolation already covers it.
2. **Keep `pendingNotifications` untouched.** Pre-input buffer, not a queue. Folding it would change sub-agent notification semantics.
3. **Drop batching from v1.** Requires `workload` field on submissions; separate refactor.
4. **Drop `remove(uuid)` / `popAll(filter)`.** No BrowserX call sites need them.
5. **Don't touch `eventQueue`.** Different concern (event delivery), no priority need.
6. **Listener receives snapshot directly** (cleaner for Svelte/non-React consumers than claudy's `useSyncExternalStore` pattern that hands back `() => void` + a separate `getSnapshot()`).
7. **Linear scan stays O(n).** Queue depth is small; heap would be premature.
8. **`'now'` is non-preemptive.** Adopt claudy's "urgent but cooperative" semantic.

### Sources

- Claudy: `utils/messageQueueManager.ts` (480 LOC), `types/textInputTypes.ts:299-358`, `cli/print.ts:1920-2100` (drain loop + batching), `cli/print.ts:443-452, 428-434` (batching helpers), `utils/signal.ts`, `utils/QueryGuard.ts`.
- BrowserX: `src/core/engine/RepublicAgentEngine.ts:27, 28, 29, 30, 37, 44, 123-133, 208-216, 271-273, 286, 299-312, 318-325, 345-358, 364-371, 427-452, 602, 820, 835-837, 846-852, 904-916`, `src/core/engine/RepublicAgentEngineConfig.ts:176-200`, `src/core/RepublicAgent.ts:405-516`, `src/tools/AgentTool/SubAgentRunner.ts:130-176, 232-248`, `src/core/QueueProcessor.ts` (343 LOC dead, deletion target).

---

## Dropped from earlier proposals (preserved for context)

The pre-2026-05-14 design carried three proposals the first audit eliminated. Recorded so future contributors don't re-propose them.

### Signal (`createSignal<T>()`)

Dropped after 2026-05-13 audit. Of 20 `Signal` instances in claudy, 9 are CLI-specific (chokidar watchers, tmux session switches, Slack channel cache, GrowthBook flags) and ~10 are React-adapter shapes for `useSyncExternalStore`. Svelte's `writable()` covers both the state and the subscribe surface natively. The one BrowserX consumer (`CommandQueue.subscribe`) is a 10-line internal `Set<Listener>` — no exported primitive needed.

### Mailbox (`new Mailbox<T>()`)

Dropped after 2026-05-13 audit. Claudy uses `Mailbox` in exactly one place (`useMailboxBridge` via `context/mailbox.tsx`) and only calls `poll()`, never `receive()`. The one BrowserX use case (buffering user input while busy) is already solved by `TurnState.pendingInput` + `Session.addPendingInput()`.

### ApprovalManager refactor

Dropped after 2026-05-13 audit. The 547 lines are mostly policy/risk/events; the resolver pattern itself is ~30 lines and works correctly. BrowserX's `ApprovalManager` is more complete than claudy's flow (timeout, policy, ApprovalGate hooks, risk enhancers).

---

## Deferred: EventLog

Tracked in **[#215](https://github.com/The-AI-Republic/browserx/issues/215)**. Full design preserved in the issue. Pick up when: a real debugging incident occurs, a user-facing activity-log feature is prioritized, a compliance requirement surfaces, or `CommandQueue.subscribe` proves insufficient.

## Deferred: MessageBus

Stays deferred. `ChannelManager` (PR #174) + `ServiceRegistry` + `HookDispatcher` (PR #198) + `CommandQueue.subscribe` (this track) already cover routing + observation. Reassess only if a real consumer emerges that none of those can serve.
