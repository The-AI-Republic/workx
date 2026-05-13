# Track 08b: CommandQueue (Typed Input Queue with Priorities)

> **Status (2026-05-13):** Design ready, blocked on 08a landing first (uses `Signal<T>`).
> Active PR: none.
>
> Key decisions resolved (see [Validation Notes 2026-05-13](#validation-notes-2026-05-13)):
> - **Source:** port `claudy/utils/messageQueueManager.ts` priority/dequeue/filter shape; replace plain `submissionQueue: Submission[]` in `RepublicAgent` and the unused `pendingNotifications` in `RepublicAgentEngine`.
> - **Naming:** `CommandQueue<T>` (no collision; audited).
> - **Three priorities:** `'now' > 'next' > 'later'` (claudy's exact tiers). Same defaults: user input → `'next'`, task notifications → `'later'`, explicit interrupts → `'now'`.
> - **Critical filter parameter** (`agentId` / `cmd => cmd.parentSessionId === me`): claudy uses this for sub-agent isolation in a unified queue. **BrowserX needs this for PR #191's background agents** — they share state with the parent but must not steal each other's notifications.
> - **`'now'` is urgent, not preemptive.** Background agents make claudy's strict idle-only drain unworkable; `'now'` signals abort to in-flight tasks but does not skip the queue.
> - **No popAllEditable.** Terminal-only re-edit-on-arrow; browserx UIs handle this differently.
> - **v1 size:** ~400 LOC new, ~50 LOC deleted (RepublicAgent submissionQueue plumbing).

## Problem

`RepublicAgent.submissionQueue: Submission[]` (`src/core/RepublicAgent.ts:48` neighborhood, paired with `processSubmissionQueue()`) is plain FIFO with these limits:

- **No priority.** A user-typed `'now'` interrupt waits behind queued background-task results.
- **No filter.** PR #191 added `pendingNotifications: string[]` (`src/core/engine/RepublicAgentEngine.ts:44`) for "background sub-agent results enqueued while parent is idle" — declared but **not yet wired**, because there's no good queue to wire it into. CommandQueue is that queue.
- **No batching.** Multiple consecutive prompts each become a separate turn, even when they should coalesce.
- **No subagent isolation.** Sub-agents (PR #191) and parent share the same `submissionQueue`. Without a filter, a parent's drain pulls out sub-agent commands meant for a different `agentId`.
- **No drain log.** Hard to debug "why didn't my command run" — no audit of enqueue/dequeue events. (08c will close this.)

Claudy solved exactly these problems in `messageQueueManager.ts`, with one difference: claudy is single-threaded (sub-agents run in-process and the parent waits). BrowserX background agents run in parallel with the parent's foreground turn (PR #191), which changes how `'now'` priority should behave.

## What Claudy Does

### `QueuedCommand` envelope (verbatim, from `claudy/src/types/textInputTypes.ts`)

```typescript
export type QueuedCommand = {
  value: string | Array<ContentBlockParam>
  mode: PromptInputMode             // 'bash' | 'prompt' | 'orphaned-permission' | 'task-notification'
  priority?: QueuePriority          // 'now' | 'next' | 'later'; defaults per mode
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  pastedContents?: Record<number, PastedContent>  // image paste support — terminal-specific
  preExpansionValue?: string         // pasted-text-placeholder bookkeeping
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean             // remote bridge filter
  isMeta?: boolean                   // hidden in UI, visible to model
  origin?: MessageOrigin             // provenance: undefined = human keyboard
  workload?: string                  // billing tag
  agentId?: AgentId                  // **THE FILTER FIELD** — undefined = main thread
}
```

### Priority constants and dequeue (verbatim)

```typescript
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,    // Interrupt: abort in-flight tool calls
  next: 1,   // Mid-turn: after current tool call finishes
  later: 2,  // End-of-turn: wait for full turn completion
}

export function dequeue(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined {
  if (commandQueue.length === 0) return undefined
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}
```

Note the **filter-first lookup**: priority is only computed for commands that pass the filter. This makes "drain only main-thread commands" or "drain only this agent's commands" cheap and correct.

### `dequeueAllMatching` for batch drain by mode (verbatim)

```typescript
export function dequeueAllMatching(predicate: (cmd: QueuedCommand) => boolean): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) matched.push(cmd)
    else remaining.push(cmd)
  }
  if (matched.length === 0) return []
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) logOperation('dequeue')
  return matched
}
```

### `processQueueIfReady` — the drain (verbatim from `claudy/src/utils/queueProcessor.ts`)

```typescript
export function processQueueIfReady({ executeInput }): ProcessQueueResult {
  // Skip anything addressed to a subagent
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)
  if (!next) return { processed: false }

  // Slash + bash run individually (need per-command UI/error isolation)
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])
    return { processed: true }
  }

  // Drain all non-slash commands with the same mode at once
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) return { processed: false }
  void executeInput(commands)
  return { processed: true }
}
```

The shape that matters for browserx: **peek with filter, dequeue with same filter, then either run-individually or batch-by-mode.**

### `QueryGuard` 3-state machine (`claudy/src/utils/QueryGuard.ts`, verbatim shape)

```typescript
class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  reserve(): boolean      // idle → dispatching (returns false if busy)
  cancelReservation()     // dispatching → idle (no-op if not dispatching)
  tryStart(): number|null // dispatching|idle → running, returns a generation token
  end(generation): boolean
  forceEnd()              // any → idle (cancels generation)
  get isActive(): boolean // 'dispatching' | 'running'
}
```

`useQueueProcessor` reacts to `[queueSnapshot, isQueryActive]`:
1. If query is active → return early (idle-drain only).
2. If queue empty → return early.
3. Else `processQueueIfReady`.

The `dispatching` state matters because the React effect re-fires the moment the snapshot changes; `dispatching` blocks re-entry while the synchronous `executeInput → handlePromptSubmit → reserve` chain runs to completion.

### Eight enqueue sources (research 2026-05-13)

| Source | Mode | Priority |
|---|---|---|
| User REPL keyboard | `'prompt'` | `'next'` (default) |
| Slash command nextInput | `'prompt'` | `'next'` |
| Bridge inbound (remote message) | `'prompt'` | `'next'` |
| Ultraplan status notifications | `'task-notification'` | `'later'` (default) |
| Cron / scheduled tasks | `'prompt'` | `'later'` |
| Orphaned permission response | `'orphaned-permission'` | `'next'` |
| Hook stop errors | `'task-notification'` | `'later'` |
| Background agent termination | `'task-notification'` | `'later'` |

Pattern: **two enqueue functions** — `enqueue(cmd)` defaults priority to `'next'` (user-facing); `enqueuePendingNotification(cmd)` defaults to `'later'` (system-generated). Same underlying queue.

## BrowserX Adaptation

### `Command<T>` envelope (browserx-shaped)

```typescript
// src/core/commandQueue/types.ts
export type CommandPriority = 'now' | 'next' | 'later'

export type CommandMode =
  | 'user-input'         // user-typed message; goes to model as user turn
  | 'task-notification'  // background sub-agent result; goes as `<task-notification>`
  | 'orphaned-approval'  // approval response delivered after the original turn ended
  | 'system'             // browserx-internal; e.g., scheduled task

export interface Command<T = unknown> {
  id: string
  mode: CommandMode
  priority?: CommandPriority
  payload: T
  enqueuedAt: number
  // Routing fields (claudy's agentId equivalent)
  parentSessionId?: string  // which session this command targets; undefined = current session
  workload?: string         // billing/telemetry tag (claudy parity)
  isMeta?: boolean          // hidden in transcript UI, visible to model
}
```

What's dropped from claudy:
- `pastedContents`, `preExpansionValue` — terminal paste expansion; browserx uses native browser paste APIs.
- `bridgeOrigin` — claudy's remote-control bridge isn't a browserx feature today.
- `MessageOrigin` — defer to 08c EventLog for provenance.

What's added:
- `parentSessionId` instead of `agentId`. Browserx PR #191 sub-agents share `agentId` with the parent but have a distinct `subAgentId` and parent linkage. The filter field has to express "is this command for me, the parent, or for one of my running sub-agents."
- Generic `payload: T` — browserx commands carry typed payloads (`UserMessageOp`, `SubAgentResultOp`, `ApprovalResolutionOp`), not just strings.

### `CommandQueue<T>` (browserx implementation sketch)

```typescript
// src/core/commandQueue/CommandQueue.ts
import { createSignal } from '../signals/signal'

const PRIORITY_ORDER: Record<CommandPriority, number> = {
  now: 0, next: 1, later: 2,
}

export class CommandQueue<T = unknown> {
  private items: Command<T>[] = []
  private snapshot: readonly Command<T>[] = Object.freeze([])
  private changed = createSignal()

  // Read API (subscribe + snapshot — for Svelte/React stores)
  subscribe = this.changed.subscribe
  getSnapshot(): readonly Command<T>[] { return this.snapshot }
  get length(): number { return this.items.length }

  // Write API
  enqueue(cmd: Command<T>): void {
    this.items.push({ ...cmd, priority: cmd.priority ?? this.defaultPriorityFor(cmd.mode) })
    this.notify()
  }

  // Read-only inspection
  peek(filter?: (cmd: Command<T>) => boolean): Command<T> | undefined { /* ... */ }

  // Dequeue: highest-priority command matching filter
  dequeue(filter?: (cmd: Command<T>) => boolean): Command<T> | undefined { /* claudy logic */ }

  // Dequeue: all commands matching predicate, preserving priority order
  dequeueAllMatching(predicate: (cmd: Command<T>) => boolean): Command<T>[] { /* claudy logic */ }

  // Targeted removal (e.g., user cancelled a queued command)
  remove(id: string): boolean { /* ... */ }
  clear(): void { /* ... */ }

  private defaultPriorityFor(mode: CommandMode): CommandPriority {
    switch (mode) {
      case 'user-input': return 'next'
      case 'task-notification': return 'later'
      case 'orphaned-approval': return 'next'
      case 'system': return 'later'
    }
  }

  private notify(): void {
    this.snapshot = Object.freeze([...this.items])  // reference change for store consumers
    this.changed.emit()
  }
}
```

Per-instance, **not module-level** like claudy. Browserx supports multiple parallel sessions; one queue per `Session` keeps semantics clean.

### `'now'` priority — urgent, not preemptive

Claudy's `'now'` is preemptive in spirit but not implementation: it dequeues first when idle, but **never** mid-query (the QueryGuard `isActive` gate blocks all dequeues). PR #191's background agents change the picture:

| Claudy | BrowserX (with PR #191 background agents) |
|---|---|
| One foreground query at a time. `'now'` waits for idle. | Foreground query + N background sub-agents may all be running. |
| `'now'` signals nothing extra; it just sorts to the front of the queue at next idle. | `'now'` should also **emit an "interrupt-foreground" signal** so in-flight work can decide to abort. |

Concretely: a `'now'` command enqueued while the foreground turn is running:
1. Goes to the head of the queue (priority 0).
2. Triggers a `commandQueue.urgentEnqueued` signal (separate from the regular `changed` signal).
3. The foreground turn's runner subscribes to that signal and decides whether to abort (e.g., by passing the abort along its `AbortController` chain).
4. Background sub-agents do **not** subscribe — they keep running. `'now'` is for the foreground.

This keeps PR #191's background-task model intact while giving "user typed something urgent" a way to interrupt.

### Subagent isolation via `parentSessionId`

The drain filter for the foreground:
```typescript
const isForCurrentSession = (cmd: Command) =>
  cmd.parentSessionId === undefined || cmd.parentSessionId === currentSession.id
```

For each background sub-agent's drain (their CommandQueue is separate; this is for shared/parent queue access only):
```typescript
const isForSubAgent = (cmd: Command) =>
  cmd.parentSessionId === subAgent.id
```

This matches claudy's `isMainThread = cmd => cmd.agentId === undefined` pattern but generalized to N sub-agents.

### Browserx `QueryGuard` equivalent

Browserx `RepublicAgentEngine` already has a `processingSubmission` boolean. We promote it to a 3-state guard mirroring claudy:

```typescript
// src/core/engine/QueryGuard.ts
import { createSignal } from '../signals/signal'

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _gen = 0
  private changed = createSignal()

  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this.changed.emit()
    return true
  }
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this.changed.emit()
  }
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    return ++this._gen
  }
  end(gen: number): boolean {
    if (gen !== this._gen || this._status !== 'running') return false
    this._status = 'idle'
    this.changed.emit()
    return true
  }
  forceEnd(): void {
    this._status = 'idle'
    ++this._gen
    this.changed.emit()
  }

  subscribe = this.changed.subscribe
  get isActive(): boolean { return this._status !== 'idle' }
  get status() { return this._status }
}
```

The generation counter prevents stale `end()` calls from a forcibly-cancelled previous turn from resetting a freshly-started one.

### The browserx drain — `processCommandQueueIfReady`

```typescript
// src/core/engine/CommandQueueDrain.ts
function processCommandQueueIfReady<T>(args: {
  queue: CommandQueue<T>
  guard: QueryGuard
  forSession: string
  executeBatch: (cmds: Command<T>[]) => Promise<void>
}): boolean {
  if (args.guard.isActive) return false
  const isOurs = (c: Command<T>) => c.parentSessionId === undefined || c.parentSessionId === args.forSession
  const next = args.queue.peek(isOurs)
  if (!next) return false

  // Approval resolutions and explicit single-command modes drain individually
  if (next.mode === 'orphaned-approval' || next.mode === 'system') {
    const cmd = args.queue.dequeue(isOurs)!
    void args.executeBatch([cmd])
    return true
  }

  // Otherwise batch all commands of the same mode
  const batch = args.queue.dequeueAllMatching(c => isOurs(c) && c.mode === next.mode)
  if (batch.length === 0) return false
  void args.executeBatch(batch)
  return true
}
```

Wired into `RepublicAgent` and `RepublicAgentEngine` with one subscriber to `queue.subscribe` and one subscriber to `guard.subscribe` — re-runs the drain check on either signal.

### Wire up the unused `pendingNotifications`

`RepublicAgentEngine.pendingNotifications: string[]` (`src/core/engine/RepublicAgentEngine.ts:44`) was added by PR #191 with the comment *"Notifications enqueued while no turn is active. Drained and prepended to the next run() / sendFollowUp() so background sub-agent results are not silently dropped when the parent is idle."* — but never wired.

Replace it:
```typescript
// On sub-agent completion (from SubAgentRunner)
parentSession.commandQueue.enqueue({
  id: `task-notif-${subAgentId}`,
  mode: 'task-notification',
  priority: 'later',
  payload: notificationText,
  enqueuedAt: Date.now(),
  parentSessionId: parentSession.id,
})
```

The drain picks it up next idle and feeds it into the parent's next user turn as a synthetic `<task-notification>` user message — the pattern PR #191 designed for but couldn't implement until the queue existed.

### What we explicitly do NOT port from claudy

- **`popAllEditable` / arrow-up to re-edit a queued command.** Terminal-only ergonomics; browserx UIs (extension popup, desktop window, web app) handle editing via standard text inputs.
- **`pastedContents` / `preExpansionValue`.** Browser paste APIs already give us the expanded text.
- **`bridgeOrigin`.** No remote-bridge feature.
- **`MessageOrigin` / `workload` as first-class fields on every command.** `workload` rides as an optional tag (claudy parity for billing); origin moves to 08c EventLog metadata.
- **Headless/print.ts non-React drain loop.** Browserx engine is already non-React; the drain is just `subscribe → drain` everywhere.

## Naming & Collisions

Audited 2026-05-13:

| Name | Status |
|------|--------|
| `CommandQueue` | Not used (`QueueProcessor.ts` had `SubmissionQueue`, dead) — **use** |
| `Command<T>` | Not used as a type — **use** |
| `CommandMode`, `CommandPriority` | Not used — **use** |
| `QueryGuard` | Not used — **use** (matches claudy name) |
| `src/core/commandQueue/` directory | Doesn't exist — **create** |

## v1 Plan (this PR — ~400 LOC new, ~50 LOC deleted)

**Step 1 — `Command<T>` and `CommandPriority` types** (`src/core/commandQueue/types.ts`, ~40 LOC)

**Step 2 — `CommandQueue<T>` class** (`src/core/commandQueue/CommandQueue.ts`, ~120 LOC)
- Per-instance (not module global)
- `enqueue / peek / dequeue / dequeueAllMatching / remove / clear`
- `subscribe / getSnapshot / length`
- Snapshot/freeze pattern for store consumers
- Default priority by mode

**Step 3 — `QueryGuard` 3-state machine** (`src/core/engine/QueryGuard.ts`, ~60 LOC)
- Replaces `RepublicAgentEngine.processingSubmission: boolean`
- Generation counter prevents stale end() calls

**Step 4 — `processCommandQueueIfReady`** (`src/core/engine/CommandQueueDrain.ts`, ~50 LOC)
- Filter-by-session, then peek + dequeue or batch-by-mode

**Step 5 — Replace `RepublicAgent.submissionQueue` plumbing** (~50 LOC delete + ~30 LOC add)
- `submissionQueue: Submission[]` → `commandQueue: CommandQueue<Submission>` (or split into typed payload variants)
- `processSubmissionQueue()` → subscribe to `(queue.subscribe, guard.subscribe)` and call `processCommandQueueIfReady`
- Preserve external API (`submitOperation`, `getNextEvent`) — internal change only

**Step 6 — Wire background sub-agent notifications** (~30 LOC)
- Remove `RepublicAgentEngine.pendingNotifications: string[]` (line 44)
- `SubAgentRunner` on completion enqueues `{ mode: 'task-notification', priority: 'later', parentSessionId }` into parent's `commandQueue`
- The drain handles delivery as a synthetic user turn

**Step 7 — `'now'` urgent-interrupt signal** (~30 LOC)
- `commandQueue.urgentEnqueued: Signal<[Command]>` fires when a `'now'` command is enqueued
- `RepublicAgent.foregroundRunner` subscribes; on urgent enqueue, raises its `AbortController`
- Sub-agents ignore the signal — they're not the foreground

**Step 8 — Tests** (`tests/core/commandQueue/`, ~250 LOC)
- Priority ordering: enqueue mixed `'now'` / `'next'` / `'later'`, verify dequeue order
- Batch by mode: enqueue 3 `'user-input'` + 1 `'task-notification'`, verify drain pulls 3 user-inputs together
- Filter by session: parent + sub-agent commands interleaved; parent drain only takes parent's
- `'now'` signal: enqueue urgent → urgentEnqueued signal fires
- QueryGuard: reserve/cancelReservation/tryStart/end/forceEnd state transitions
- QueryGuard generation: forceEnd then end(oldGen) returns false

**Step 9 — Behavior parity**
- Existing `Session` and `RepublicAgentEngine` tests must still pass
- New tests for sub-agent notification delivery (proves `pendingNotifications` replacement works)

## Follow-on (NOT in this PR)

| Track | Scope |
|-------|-------|
| **08b-followup** | Per-mode rate limiting on `enqueue` (e.g., debounce `task-notification` floods) |
| **08b-followup** | Stale-command timeout (a `'later'` command queued > N minutes auto-expires) |
| **08c** | EventLog subscribes to `commandQueue.changed` and `urgentEnqueued` for the audit trail |
| **07** | Track 07's `agentState.runningTasks` mirrors a derived view of the queue + active turns |

## Risks

- **Sub-agent isolation correctness.** A misfiled `parentSessionId` means a parent could drain a sub-agent's command (or vice versa). Mitigation: `parentSessionId` is set at the enqueue site by the writer, never inferred. Tests cover both interleavings.
- **`'now'` interrupt semantics differ from claudy.** Claudy is "wait for idle then dequeue"; we add "also signal foreground to consider aborting." Risk: foreground runner aborts in the middle of a tool call that was about to succeed. Mitigation: the signal is advisory; the foreground runner inspects context (mid-tool? mid-stream?) before actually calling `abort()`.
- **QueryGuard generation race.** If `forceEnd` fires between `tryStart` and `end`, the `end` returns false and the guard is left correctly idle. Tests cover this. The risk is in any caller that ignores the `end()` return value; reviewed in tests.
- **Snapshot freeze cost.** Every `enqueue/dequeue/clear` creates a new frozen array. For sessions with thousands of queued commands this could dominate. Today nobody queues thousands; revisit if a 08b-followup adds rate-limit deferrals that grow the queue.

## Validation Notes (2026-05-13)

Re-validated against claudy + browserx via parallel research probes 2026-05-13.

### Claudy findings

- `messageQueueManager.ts` is a **module-level** singleton queue with extensive read/write API. We chose **per-instance** for browserx because of multi-session.
- `agentId` field is the linchpin of subagent isolation — without it, the unified queue (introduced after PR #18453 unified what used to be dual queues) loses isolation. We mirror this with `parentSessionId`.
- `QueryGuard` 3-state pattern is robust and worth porting verbatim — generation counter prevents the edge case where a forcibly-ended generation's stale `finally` block flips a freshly-started query back to idle.
- `processQueueIfReady` is small (~30 LOC) and the batching logic is the key idea: peek to find the head's mode, then drain all commands of that mode together. Slash + bash run individually because they need per-command UI/error isolation.
- **Eight enqueue sources** in claudy, two enqueue functions (`enqueue` defaults `'next'`, `enqueuePendingNotification` defaults `'later'`). We follow the convention: per-mode default priority via `defaultPriorityFor`.
- `popAllEditable` is REPL-only (UP arrow re-edits queued commands). Skip.

### BrowserX-side findings

- `RepublicAgent.submissionQueue: Submission[]` (`src/core/RepublicAgent.ts:48` neighborhood) is plain FIFO. `processSubmissionQueue()` is `while shift await`. Trivial to swap.
- `RepublicAgentEngine.pendingNotifications: string[]` (line 44) **is declared but unused.** PR #191 documented the intent: "background sub-agent results enqueued while parent is idle, drained and prepended to next run." This is exactly the `'task-notification'` mode use case. We delete the field and replace with the queue.
- `RepublicAgentEngine.eventWaiters: Array<(event) => void>` (line 30) is the **second** manual-resolver pattern (08a's first refactor target was ApprovalManager). 08a-followup will migrate this; 08b doesn't touch it.
- Naming all clear (`CommandQueue`, `Command<T>`, `QueryGuard`, `src/core/commandQueue/` — none exist).
- 08a (`Signal<T>`) is a **hard prerequisite**: `CommandQueue.changed` and `urgentEnqueued` both use `Signal<T>`. 08b cannot land before 08a.

### Decisions resolved

1. **Per-instance `CommandQueue<T>`**, not module global. Multi-session.
2. **`parentSessionId` filter field**, generalizing claudy's `agentId`.
3. **`'now'` is urgent (signals abort), not preemptive (skips queue gate).** Background agents make true preemption nonsensical.
4. **No `popAllEditable`.** Browserx UIs handle re-edit natively.
5. **Wire `pendingNotifications` replacement in same PR.** It's the proof-of-value — turns a documented-but-unwired PR #191 feature into reality.
6. **Drop `pastedContents`, `preExpansionValue`, `bridgeOrigin`.** Terminal/REPL features.
7. **Keep `workload` for billing parity, defer `MessageOrigin` to 08c.**

### Open items deliberately deferred

- Per-mode rate limiting / debouncing (08b-followup)
- Stale-command expiry (08b-followup)
- EventLog subscription to queue events (08c)
- Migrating `eventWaiters` to Mailbox (08a-followup)

Sources:
- Claudy: `utils/messageQueueManager.ts`, `utils/queueProcessor.ts`, `utils/QueryGuard.ts`, `types/textInputTypes.ts`, `hooks/useQueueProcessor.ts`, plus 8 enqueue call sites verified.
- BrowserX: `src/core/RepublicAgent.ts:48` neighborhood, `src/core/engine/RepublicAgentEngine.ts:30, 44, 116`, `src/core/QueueProcessor.ts` (deleted in 08a).
