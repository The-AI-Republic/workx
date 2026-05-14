# Track 08: Centralized Message Queue

> **Status (2026-05-14):** Implementation-ready, single phase. Active PR: none.
>
> Originally split into 08a (Signal+Mailbox primitives), 08b (CommandQueue), 08c (EventLog), and 08d (MessageBus). After a deep audit of both claudy and browserx the scope collapsed:
>
> - **08a primitives** (Signal, Mailbox, ApprovalManager refactor) — dropped. Audit showed BrowserX has functional equivalents already (HookRegistry, Svelte stores, `TurnState.pendingInput`, the existing `ApprovalManager`). Rationale preserved below in [Dropped from Earlier Proposals](#dropped-from-earlier-proposals).
> - **08c EventLog** — deferred to **[#215](https://github.com/The-AI-Republic/browserx/issues/215)** pending a validated consumer. Honest framing: claudy ships approval/tool/hook telemetry to Datadog + OTel (not local files); BrowserX has no remote telemetry destination, so a local audit store is a real gap — but not an urgent one until something asks for it. Short note below in [Deferred: EventLog](#deferred-eventlog).
> - **08d MessageBus** — stays deferred. Note below in [Deferred: MessageBus](#deferred-messagebus).
>
> What remains in this track is one focused slice: **replace the FIFO `submissionQueue` with a priority-aware `CommandQueue<T>`**, fold the `pendingNotifications` workaround into it, and delete the dead `QueueProcessor.ts`.

---

## Problem

`RepublicAgentEngine.submissionQueue: Submission[]` (`src/core/engine/RepublicAgentEngine.ts:27`) is a plain array drained via `shift()`. Three concrete pain points:

### Pain 1 — No priorities, so background work can block foreground

A user-typed message sits behind queued background-task notifications because the queue is strict FIFO. There is no "user input jumps the line" mechanism, no "this is an urgent abort signal, process it first." Every submission has identical weight.

### Pain 2 — `pendingNotifications` is a parallel structure for sub-agent results

When a background sub-agent finishes, `enqueueSyntheticUserTurn(text)` (`RepublicAgentEngine.ts:299-312`) needs to deliver the result to the parent agent. Today's flow:

- If the parent is mid-turn: append to `TurnState.pendingInput` (correct, this is what `pendingInput` is for).
- If the parent is idle: push the text into `pendingNotifications: string[]` (`RepublicAgentEngine.ts:44`), to be drained as a prefix of the next user input via `drainPendingNotificationsInto` (`RepublicAgentEngine.ts:318-325`).

The `pendingNotifications` array is a workaround introduced by PR #191 because the FIFO `submissionQueue` had no way to express "this submission is from agent X, deliver it as part of agent Y's next turn." It works, but it's a second queueing structure with bespoke semantics next to the main queue. Folding both into one priority-aware queue collapses the duplication.

### Pain 3 — Dead `QueueProcessor.ts`

`src/core/QueueProcessor.ts` (343 LOC) defines `PriorityQueue<T>`, `SubmissionQueue extends PriorityQueue<Submission>`, `EventQueue extends PriorityQueue<Event>`, and a `QueueProcessor` orchestrator. **Never instantiated in production code** (verified 2026-05-14). Carrying two competing priority-queue implementations invites future drift.

### Things that are NOT pain points (surprising findings from the audit)

The earlier 08b design framed several other things as gaps. The audit pushed back on most of them:

- **Per-engine queue isolation works fine.** Each `RepublicAgentEngine` already has its own `submissionQueue`. Claudy uses *one shared queue* with `agentId` filtering — which means every dequeue caller has to remember to pass the right filter. BrowserX's segregation eliminates that bug class entirely. The `engineId` filter we're adding is **specifically for the sub-agent-to-parent notification path**, not a general cross-talk fix.
- **`'now'` priority doesn't need preemption.** Claudy's `'now'` priority does *not* abort an in-flight tool call — subscribers see the priority and can abort if they want. Adding tool-cancellation plumbing is out of scope; "urgent but cooperative" is fine.
- **`ApprovalManager`'s resolver Map is fine.** Earlier proposals wanted to refactor it with a Mailbox. The audit confirmed BrowserX's `ApprovalManager` is more complete than claudy's flow; the resolver pattern is ~30 lines of a 547-line file and works correctly.

---

## Research Synthesis

This scope is the result of two parallel deep-audit probes run 2026-05-14: one mapping claudy's full message/queue/event/approval/audit pipeline (`/home/rich/dev/study/claudy/src`), one mapping BrowserX's equivalent. The matrix below is the gap analysis.

| Capability | Claudy has | BrowserX has | Real gap? |
|---|---|---|---|
| Input buffer while busy | `Mailbox` (1 use site: `useMailboxBridge`) | `TurnState.pendingInput` + `Session.addPendingInput()` | ✅ Already covered |
| Background sub-agent result injection | enqueue with `'later'` | `pendingNotifications` + `enqueueSyntheticUserTurn()` (workaround) | ⚠️ Works, but via a parallel array → **folded into Phase 1** |
| Pub/sub primitive | `Signal` (mostly React adapters) | HookRegistry + Svelte stores | ✅ Already covered |
| Inter-process IPC (swarm) | `teammateMailbox` (disk JSON) | N/A — single process | ✅ Not applicable |
| Approval request/response | tool-result return path + per-handler logic | `ApprovalManager` (timeout, policy, ApprovalGate hooks, risk enhancers) | ✅ Already covered; BrowserX's is more complete |
| Lifecycle hooks | hooks system | `HookRegistry` / `HookDispatcher` (PR #198) | ✅ Already covered |
| Cross-platform routing | n/a (CLI only) | `ChannelManager` + `ServiceRegistry` (PR #174) | ✅ Already covered |
| **Priority-ordered queue** (`now`/`next`/`later`) | `messageQueueManager` | plain FIFO | ❌ **Phase 1** |
| **Filter-on-dequeue for sub-agent ↔ parent flow** | yes, every `dequeue()` | none; parallel `pendingNotifications` array workaround | ❌ **Phase 1** |
| **Persistent local audit log** | claudy logs queue ops to JSONL; everything else to Datadog/OTel | nothing | ⏸ **Deferred → [#215](https://github.com/The-AI-Republic/browserx/issues/215)** |
| **Dead `QueueProcessor.ts`** | n/a | 343 LOC, never instantiated | 🗑️ Phase 1 cleanup |

### What the audit reframed

- **`Mailbox.receive()` is never called in claudy.** The await-for-message pattern that 08a's design treated as load-bearing has zero consumers in claudy itself.
- **BrowserX's `ApprovalManager` is more complete than claudy's approval flow.** Timeout, policy, `ApprovalGate` hook integration, risk enhancers, history map — none of these exist as a single coherent layer in claudy.
- **Claudy's audit story isn't what the original design claimed.** Queue ops are logged to a session JSONL (true), but approval decisions go to **Datadog**, tool timing goes to **OpenTelemetry**, and hook firings aren't persisted at all. There's no single audit store on disk to "port." If BrowserX wants a local equivalent, we'd be building what claudy *should* have, not what claudy has — that's why EventLog moved to [#215](https://github.com/The-AI-Republic/browserx/issues/215) pending a real consumer.

---

## Phase 1: CommandQueue

### Goal

Replace `RepublicAgentEngine.submissionQueue: Submission[]` *and* `pendingNotifications: string[]` with a single `CommandQueue<Submission>` that is priority-ordered, filter-aware, and observable.

### Envelope

```typescript
// src/core/queue/types.ts
export type QueuePriority = 'now' | 'next' | 'later';

export interface QueuedCommand<T> {
  readonly uuid: string;
  readonly payload: T;
  readonly priority: QueuePriority;
  readonly engineId?: string;   // undefined = unfiltered / main agent
  readonly workload?: string;   // for optional batching of consecutive prompts
  readonly enqueuedAt: number;
}

export interface EnqueueOptions {
  priority?: QueuePriority;
  engineId?: string;
  workload?: string;
}

export type DequeueFilter<T> = (cmd: QueuedCommand<T>) => boolean;
```

### API

```typescript
// src/core/queue/CommandQueue.ts
export class CommandQueue<T> {
  enqueue(payload: T, opts?: EnqueueOptions): string;          // returns uuid
  dequeue(filter?: DequeueFilter<T>): QueuedCommand<T> | undefined;
  dequeueBatch(filter: DequeueFilter<T>, maxBatch?: number): QueuedCommand<T>[];
  peek(filter?: DequeueFilter<T>): QueuedCommand<T> | undefined;
  remove(uuid: string): boolean;
  popAll(filter?: DequeueFilter<T>): QueuedCommand<T>[];
  clear(): void;
  get length(): number;
  /** Subscribe to mutations; returns unsubscribe. */
  subscribe(listener: (snapshot: ReadonlyArray<QueuedCommand<T>>) => void): () => void;
}
```

No new exported pub/sub primitive. `subscribe` uses a private `Set<Listener>` (~10 lines), fires on every mutation with a frozen snapshot.

### Priority semantics (matches claudy's `messageQueueManager.ts:151-155`)

- **`'now'`** — pulled before everything else. **Not preemptive**: does not abort an in-flight turn. The drain loop picks it on the next iteration. BrowserX's parallel background sub-agents make preemption messy; we adopt claudy's "urgent but cooperative" semantic.
- **`'next'`** — drained mid-turn before the next API round-trip. Default for user input.
- **`'later'`** — lowest. Drained as a new turn after the current one ends. Default for sub-agent notifications and scheduler ticks.

### Default priorities by submission source

| Source (current code location) | Priority |
|---|---|
| User text submission (`RepublicAgent.submitOperation` → `UserInput` op) | `'next'` |
| `Interrupt`, `Shutdown` ops | `'now'` |
| `ExecApproval` op | `'now'` |
| Sub-agent background result (`enqueueSyntheticUserTurn` → enqueue here) | `'later'` |
| Scheduler tick (`src/core/scheduler/`) | `'later'` |
| `ServiceRequest` ops | `'next'` |

### Sub-agent → parent flow (the `pendingNotifications` replacement)

Each `RepublicAgentEngine` has an `engineId` (`RepublicAgentEngine.ts:19`). Sub-agent engines inherit `parentEngineId` (`RepublicAgentEngine.ts:357`).

**Before** (current code):

```typescript
// Sub-agent finishes, parent is idle:
this.pendingNotifications.push(text);     // parallel array

// Parent starts next turn:
const input = drainPendingNotificationsInto(originalInput);  // prepend
```

**After** (Phase 1):

```typescript
// Sub-agent finishes, parent is idle:
this.parentEngine.submissionQueue.enqueue(
  { type: 'UserInput', items: [{ type: 'text', text }] },
  { priority: 'later', engineId: this.parentEngineId },
);
// no special parent code — drain loop picks it up naturally
```

The parent's drain loop filters by `engineId`:

```typescript
this.submissionQueue.dequeue((cmd) =>
  cmd.engineId === this.engineId || cmd.engineId === undefined,
)
```

`pendingNotifications: string[]` and `drainPendingNotificationsInto` are deleted. Sub-agent notifications and ordinary user submissions live in one queue, ordered by priority.

### Batching (optional, can defer)

Consecutive `'prompt'`-mode commands from the same `workload` can coalesce into one turn:

```typescript
const batch = queue.dequeueBatch(
  (cmd) => cmd.workload === workload && isPromptMode(cmd.payload),
  10,
);
const mergedText = batch.map(c => extractText(c.payload)).join('\n\n');
```

For v1, batching can be left as an unused API surface; the drain loop in `processSubmissionQueue` can call `dequeue` only. Wire it up if a real consumer appears.

### Migration plan

1. Add `src/core/queue/types.ts` and `src/core/queue/CommandQueue.ts`.
2. Modify `RepublicAgentEngine`:
   - Replace `submissionQueue: Submission[]` with `submissionQueue: CommandQueue<Submission>`.
   - Update `submitOperation` (`RepublicAgentEngine.ts:116-126`) to call `enqueue()` with priority derived from op type.
   - Update `processSubmissionQueue` (`RepublicAgentEngine.ts:378-403`) to call `dequeue(filter)`.
   - Delete `pendingNotifications: string[]` and `drainPendingNotificationsInto`.
   - Modify `enqueueSyntheticUserTurn` (`RepublicAgentEngine.ts:299-312`) to enqueue into the parent's `CommandQueue` rather than push to a string array.
3. Delete `src/core/QueueProcessor.ts` and `src/core/__tests__/QueueProcessor.test.ts`.
4. Tests in `src/core/queue/__tests__/`:
   - Priority ordering (`now` > `next` > `later`, FIFO within tier).
   - `engineId` filter behavior for sub-agent → parent notifications.
   - `remove(uuid)` and `popAll(filter)`.
   - `subscribe` fires on every mutation.
   - `dequeueBatch` returns up to N matching items.

### Naming collision audit (verify before merge)

```bash
grep -rn "class CommandQueue\|interface CommandQueue\|type CommandQueue\b" src/
```

Verify no existing symbol named `CommandQueue` in `src/`. If a collision exists, fall back to `MessageQueue<T>` or `SubmissionQueueV2`.

### Estimated size

- **New:** ~300 LOC (CommandQueue + types + tests + engine wiring).
- **Deleted:** ~350 LOC (`QueueProcessor.ts` + `pendingNotifications` plumbing + tests).
- **Net:** roughly LOC-neutral, plus first-class priority + filter capability.

---

## Deferred: EventLog

Tracked in **[#215](https://github.com/The-AI-Republic/browserx/issues/215)**.

Full design preserved in the issue body. Short version of the rationale:

- Claudy's audit isn't actually local — approval decisions go to Datadog, tool timing to OTel. Only conversation/queue-op breadcrumbs land in the per-session JSONL.
- BrowserX has no remote telemetry destination, so a local audit store is a real architectural gap — but not an urgent one. No incidents are currently blocked on "why was this auto-approved?" or "did the `PreToolUse` hook fire?"
- Building ~600 LOC of storage infrastructure (new IndexedDB v5 store + SQLite migration + Rust migration + recorder + subscribers) for a hypothetical debugging need violates the repo's CLAUDE.md "don't design for hypothetical future requirements" rule.

**Lighter-weight alternative to consider first if a consumer asks:** an in-memory ring buffer (last N events per session) wired to `CommandQueue.subscribe` + `HookDispatcher.emitObservability` + `ApprovalManager` event emits — ~50 LOC, covers live debugging without storage migration. Persistent storage only needed if post-session-end queries are required.

Pick this back up when any of the trigger conditions in [#215](https://github.com/The-AI-Republic/browserx/issues/215) becomes true.

---

## Deferred: MessageBus

Originally scoped as 08d for generic topic-based pub/sub. Deferred status unchanged after the 2026-05-14 audit:

1. **`ChannelManager`** (PR #174) already routes submissions between UI channels and the agent and dispatches events back.
2. **`HookDispatcher`** (PR #198) already covers lifecycle observability with structured event kinds.
3. **`ServiceRegistry`** already handles request/response RPC.
4. **`CommandQueue.subscribe`** (this track) handles queue-state observation.

Adding a generic `MessageBus` on top would create a fourth routing layer with overlapping responsibilities. Reassess only if a concrete consumer emerges that none of the above can serve.

---

## Dropped from Earlier Proposals

The previous split (08a/b/c/d) carried three proposals that the deep audit eliminated. Recorded here so future contributors don't re-propose them without context.

### Signal (`createSignal<T>()`)

**Proposed in 08a:** port claudy's 25-line pub/sub primitive.

**Why dropped:**
- Of 20 `Signal` instances in claudy (audit 2026-05-14), 9 are CLI-specific (chokidar file watchers, tmux session switches, Slack channel cache, GrowthBook feature flags, file-index builds) — none apply to a browser extension.
- The remaining ~10 are React-adapter shapes for `useSyncExternalStore`. Svelte's `writable()` covers both the state and the subscribe surface natively; the adapter is unnecessary in this codebase.
- The one consumer that *would* exist in BrowserX (`CommandQueue.subscribe`) is a 10-line internal `Set<Listener>`. No exported primitive needed.
- `HookRegistry` (Track 01, PR #198) already covers lifecycle events with stronger guarantees (matchers, aggregation, observability).

### Mailbox (`new Mailbox<T>()`)

**Proposed in 08a:** port claudy's `Mailbox<T>` class with `send` / `receive(predicate, {timeoutMs, signal})` for request/response handshakes, and use it to refactor `ApprovalManager`.

**Why dropped:**
- Claudy uses `Mailbox` in exactly one place (`useMailboxBridge` via `context/mailbox.tsx`) and only calls `poll()`, never `receive()`. The await-for-message pattern that 08a treated as load-bearing is dead-on-arrival in claudy itself.
- The one BrowserX use case `Mailbox` would solve (buffering user input while the agent is busy) is **already solved** by `TurnState.pendingInput` + `Session.addPendingInput()` / `Session.getPendingInput()` (`src/core/session/state/TurnState.ts:16-76`, `src/core/Session.ts:489-504`).
- The other proposed use case (refactoring `ApprovalManager`) was dropped — see below.
- The separate disk-based `teammateMailbox.ts` is for inter-process IPC between separate agent processes in claudy's swarm feature; BrowserX is single-process, so this concept does not transfer.

### ApprovalManager refactor

**Proposed in 08a:** rewrite `ApprovalManager.requestApproval` to use a `Mailbox`, replacing the `Map<id, PendingApproval>` resolver pattern.

**Why dropped:**
- The deep audit revealed `ApprovalManager`'s 547 lines are mostly **policy evaluation**, **risk assessment**, **event emissions**, and **history tracking** — not the resolver dance. The resolver pattern itself is ~30 lines (`src/core/ApprovalManager.ts:101-185`) and works correctly.
- BrowserX's `ApprovalManager` is **more complete than claudy's approval flow**: claudy returns interactive approvals via tool-result return paths and only uses Mailbox for swarm-worker scenarios. BrowserX has timeout (600s default), policy evaluation, `ApprovalGate` hook integration (PR #198), risk enhancers (DOM, semantic, domain sensitivity), and persistent approval history map.
- A rewrite would touch a load-bearing 547-line file for stylistic gain only, with non-trivial regression risk around the auto-approve-on-timeout semantics and four event emission sites.
- If a future need emerges (e.g., cancel-on-session-end via `AbortController`), it can be added in-place without a new primitive.

---

## Dependencies

```
PR #191 (background sub-agents) ──> 08 Phase 1 CommandQueue
                                    (folds pendingNotifications workaround into priority queue)

08 Phase 1 ──> #215 EventLog (when triggered)
            ──> Deferred 08d MessageBus reassessment (no work expected)
```

Phase 1 has no blocking dependencies and can ship as a single PR.

---

## Risks

- **`enqueueSyntheticUserTurn` semantic change.** Today's `pendingNotifications` always appends as text items to the next turn's input. After Phase 1, sub-agent notifications enqueue into the parent's `CommandQueue` with `priority: 'later'`. The drain order changes from "always prepended" to "later than any pending user input." This is the correct behavior (user input goes first), but it's a behavior shift. **Mitigation:** integration test that drives a foreground prompt + background sub-agent completion concurrently and asserts the foreground prompt is processed first.
- **`engineId` filter correctness.** A bug in the filter could cross-talk commands between agents. **Mitigation:** test matrix covering main agent, sub-agent, and grandchild-agent dequeue patterns; assert no command meant for one engine surfaces in another's drain.
- **`'now'` priority is non-preemptive.** A user pressing an interrupt while a 30 s tool call runs will not abort that tool — it will queue and execute when the tool returns. This is consistent with claudy and avoids adding tool-cancellation plumbing to this track. **Mitigation:** document the semantic clearly in the queue type. Actual preemption is out of scope; if needed, it's a future track.
- **Deleting `QueueProcessor.ts` removes dead `PriorityQueue<T>`.** Re-verify before deletion: `grep -rn "QueueProcessor\|SubmissionQueue\|EventQueue" src/ --include="*.ts" | grep -v __tests__` should return no production callers (only `RepublicAgent.eventQueue` false positive — different name, same word).

---

## Validation Notes (2026-05-14)

Two parallel deep-audit probes informed this scope. Key concrete findings:

### Claudy mapping

- **`messageQueueManager.ts`** (`/home/rich/dev/study/claudy/src/utils/messageQueueManager.ts:53-193`): module-level `commandQueue: QueuedCommand[]` array. Priorities at line 151-155. `dequeue(filter)` at 167-193. `agentId` filter at line 1924 of `print.ts` (the main drain loop). `recordQueueOperation()` audit calls at lines 131, 191, 290, 472.
- **`QueuedCommand` schema** (`/home/rich/dev/study/claudy/src/types/textInputTypes.ts:299-358`): fields include `priority`, `agentId`, `workload`, `uuid`, `mode`, `isMeta`, `origin`.
- **Mailbox** (`utils/mailbox.ts`): 75 lines, used in 1 React Context, only via `poll()`. `receive()` has 0 callers.
- **TeammateMailbox** (`utils/teammateMailbox.ts`): ~1100 lines, disk-based IPC, completely separate from in-memory Mailbox. Single-process BrowserX does not need this.
- **Signal** (`utils/signal.ts`): 43 lines, 20 instantiations, 9 CLI-specific, ~10 React-adapter.
- **Audit log**: claudy logs queue ops to the per-session JSONL alongside conversation. Approval decisions go to **Datadog** (`tengu_tool_use_*` events). Tool timing/errors go to **OpenTelemetry**. Hook firings are not persisted. No local query API.

### BrowserX mapping

- **`RepublicAgentEngine.submissionQueue: Submission[]`** at `src/core/engine/RepublicAgentEngine.ts:27`. `processSubmissionQueue()` at line 378-403 (synchronous drain via `shift()`).
- **`pendingNotifications: string[]`** at line 44, drained by `drainPendingNotificationsInto(input)` at line 318-325. Wired into `enqueueSyntheticUserTurn` at line 299-312.
- **`TurnState.pendingInput: InputItem[]`** at `src/core/session/state/TurnState.ts:16`. Producer/consumer: `Session.addPendingInput` (line 504), `Session.getPendingInput` (line 489). Drained at turn boundaries by `TaskRunner.buildNormalTurnInput`.
- **`ApprovalManager`** at `src/core/ApprovalManager.ts` (547 lines). Resolver Map at line 80, `requestApproval` at line 101, `handleDecision` at 190, `cancelRequest` at 277. Default timeout 600_000 at line 110.
- **`ApprovalGate`** at `src/core/approval/ApprovalGate.ts:215, 379` fires `PermissionRequest` / `PermissionDenied` hooks (Track 01, PR #198).
- **`HookDispatcher`** at `src/core/hooks/HookDispatcher.ts:76-154`. 13 hook events defined. `emitObservability` is the single observability choke point.
- **`QueueProcessor.ts`** at `src/core/QueueProcessor.ts` (343 lines): dead. Re-verified 2026-05-14 — only references are its own colocated tests.
- **`ChannelManager`** + **`ServiceRegistry`** (PR #174) — cross-platform routing complete.

### Decisions resolved

1. **Drop Signal entirely.** Svelte stores + HookRegistry + inline `Set<Listener>` cover every use case BrowserX would actually have.
2. **Drop Mailbox entirely.** `TurnState.pendingInput` is the existing equivalent; claudy doesn't use `Mailbox.receive()` either.
3. **Drop ApprovalManager refactor.** Current implementation is correct and more complete than claudy's.
4. **Keep CommandQueue (Phase 1).** Real gap. Replaces `submissionQueue` *and* `pendingNotifications` workaround.
5. **Defer EventLog to [#215](https://github.com/The-AI-Republic/browserx/issues/215).** Real architectural gap (claudy uses Datadog/OTel which BrowserX can't reach), but no validated consumer today. Lighter-weight in-memory alternative noted in the issue.
6. **Keep `QueueProcessor.ts` deletion.** Cleanup rides along with Phase 1.
7. **MessageBus stays deferred.** No new consumer pressure surfaced.

### Sources

- Claudy: `utils/messageQueueManager.ts` (480 LOC), `utils/mailbox.ts` (75 LOC), `utils/teammateMailbox.ts` (~1100 LOC), `utils/signal.ts` (43 LOC), `types/textInputTypes.ts:299-358`, `cli/print.ts:1920-2100`, `utils/QueryGuard.ts:29-122`, `hooks/toolPermission/permissionLogging.ts` (analytics emission), `utils/telemetry/events.ts` (OTel emission).
- BrowserX: `src/core/engine/RepublicAgentEngine.ts:27, 44, 116, 299, 318, 378`, `src/core/session/state/TurnState.ts:16-76`, `src/core/Session.ts:489-504`, `src/core/ApprovalManager.ts:80-321`, `src/core/approval/ApprovalGate.ts:215, 379`, `src/core/hooks/HookDispatcher.ts:76-154`, `src/core/QueueProcessor.ts` (343 LOC dead), `src/core/registry/AgentRegistry.ts:46-82`, `src/core/channels/ChannelManager.ts:59-67`.
