# Track 08b: CommandQueue — Tasks

> v1 scope only. ~400 LOC new, ~50 LOC deleted. Single PR.
> **Hard prerequisite:** 08a (Signal + Mailbox) must be merged first — `CommandQueue.changed` and `urgentEnqueued` both use `Signal<T>`.

## Step 1 — Type definitions

- [ ] Create `src/core/commandQueue/types.ts` (~40 LOC)
  - `CommandPriority = 'now' | 'next' | 'later'`
  - `CommandMode = 'user-input' | 'task-notification' | 'orphaned-approval' | 'system'`
  - `Command<T = unknown>` interface with `id, mode, priority?, payload, enqueuedAt, parentSessionId?, workload?, isMeta?`
  - `PRIORITY_ORDER: Record<CommandPriority, number>` constant

## Step 2 — `CommandQueue<T>` class

- [ ] Create `src/core/commandQueue/CommandQueue.ts` (~120 LOC)
  - Per-instance (not module global)
  - Internal `items: Command<T>[]` and `snapshot: readonly Command<T>[]` (frozen)
  - `enqueue(cmd)` — defaults priority via `defaultPriorityFor(cmd.mode)`, calls `notify`
  - `peek(filter?)` — read-only, returns highest-priority matching command without removing
  - `dequeue(filter?)` — removes + returns highest-priority match, calls `notify`
  - `dequeueAllMatching(predicate)` — removes + returns batch, preserves remaining order, calls `notify`
  - `remove(id)` — targeted removal by id
  - `clear()` — drops all, calls `notify`
  - `subscribe = changed.subscribe` (using 08a Signal)
  - `getSnapshot(): readonly Command<T>[]`
  - `length` getter
  - `urgentEnqueued: Signal<[Command<T>]>` — fires when a `'now'` command is enqueued
  - `private notify()` — recreates frozen snapshot, emits `changed`
  - `private defaultPriorityFor(mode)` — `user-input → next`, `task-notification → later`, `orphaned-approval → next`, `system → later`
- [ ] Create `src/core/commandQueue/index.ts` re-export

## Step 3 — `QueryGuard` 3-state machine

- [ ] Create `src/core/engine/QueryGuard.ts` (~60 LOC)
  - `_status: 'idle' | 'dispatching' | 'running'`
  - `_gen: number` (generation counter)
  - `reserve(): boolean` — idle → dispatching
  - `cancelReservation(): void` — dispatching → idle
  - `tryStart(): number | null` — dispatching|idle → running, returns generation
  - `end(gen): boolean` — running → idle if generation matches
  - `forceEnd(): void` — any → idle, increments generation
  - `subscribe = changed.subscribe`
  - `get isActive(): boolean` — `_status !== 'idle'`
  - `get status()` — for debug

## Step 4 — Drain function

- [ ] Create `src/core/engine/CommandQueueDrain.ts` (~50 LOC)
  - `processCommandQueueIfReady<T>({ queue, guard, forSession, executeBatch }): boolean`
  - Filter: `parentSessionId === undefined || parentSessionId === forSession`
  - Skip if `guard.isActive` or queue empty
  - `'orphaned-approval'` and `'system'` modes drain individually
  - Other modes batch by mode via `dequeueAllMatching`
  - Returns `true` if anything was processed

## Step 5 — Replace `RepublicAgent.submissionQueue` plumbing

- [ ] Read existing `src/core/RepublicAgent.ts` `submissionQueue` and `processSubmissionQueue` end-to-end
- [ ] Replace `submissionQueue: Submission[]` with `commandQueue: CommandQueue<Submission>`
- [ ] Replace `processSubmissionQueue()` with subscribe-driven drain:
  - Subscribe to `commandQueue.changed` and `engine.queryGuard.changed`
  - On either signal, run `processCommandQueueIfReady({ queue, guard, forSession: this.sessionId, executeBatch })`
- [ ] **Preserve external API:** `submitOperation(op, context)` still returns submission id; internal change only
- [ ] Preserve `getNextEvent()` and `eventQueue` behavior unchanged (08c will refactor those)
- [ ] All existing `RepublicAgent.test.ts` and `Session.test.ts` tests must pass unchanged

## Step 6 — Wire background sub-agent notifications

- [ ] Delete `RepublicAgentEngine.pendingNotifications: string[]` (line 44)
- [ ] Delete `RepublicAgentEngine.flushPendingNotifications()` if it exists (audit)
- [ ] In `SubAgentRunner.onComplete` (or equivalent), enqueue:
  ```
  parent.commandQueue.enqueue({
    id: `task-notif-${subAgentId}-${Date.now()}`,
    mode: 'task-notification',
    priority: 'later',
    payload: notificationText,
    enqueuedAt: Date.now(),
    parentSessionId: parent.sessionId,
  })
  ```
- [ ] The drain handles delivery as a synthetic user turn — verify in tests

## Step 7 — `'now'` urgent-interrupt signal

- [ ] In `CommandQueue.enqueue`, if `priority === 'now'`, also call `this.urgentEnqueued.emit(cmd)`
- [ ] In `RepublicAgent` (foreground runner only), subscribe to `commandQueue.urgentEnqueued`:
  - Inspect current foreground turn state
  - If mid-stream or mid-tool that supports cancellation, signal abort via existing `AbortController`
  - If mid-tool that doesn't support cancellation, log and wait for natural completion
- [ ] Sub-agent runners do NOT subscribe to `urgentEnqueued` — verify by code review
- [ ] Document in code comment: "Urgent enqueue is advisory; receiver inspects context before aborting."

## Step 8 — Tests

- [ ] `tests/core/commandQueue/CommandQueue.test.ts`
  - Priority ordering: enqueue mixed `now/next/later`, verify dequeue order is `now → next → later`
  - FIFO within same priority
  - Filter: dequeue with `cmd => cmd.parentSessionId === 'A'` skips B's commands
  - Batch by mode: `dequeueAllMatching(c => c.mode === 'user-input')` returns all matching, leaves others
  - Snapshot freeze: `getSnapshot()` returns frozen array; mutations don't affect prior snapshots
  - Default priority: `enqueue({ mode: 'user-input', ... })` ends up at `'next'`; `mode: 'task-notification'` at `'later'`
  - Explicit priority overrides default
  - `urgentEnqueued` signal fires on `'now'` enqueue, not on `'next'`/`'later'`
  - `remove(id)` removes only the matching command
- [ ] `tests/core/engine/QueryGuard.test.ts`
  - Initial state is `idle`, `isActive === false`
  - `reserve()` from idle → `'dispatching'`, returns true
  - `reserve()` from non-idle returns false
  - `cancelReservation()` from `'dispatching'` → `'idle'`
  - `tryStart()` returns generation token
  - `end(gen)` returns true if gen matches, false otherwise
  - `forceEnd()` increments generation; subsequent `end(oldGen)` returns false
  - `subscribe` listener fires on every state transition
- [ ] `tests/core/engine/CommandQueueDrain.test.ts`
  - Idle + queue with one command → processes
  - Active guard → no-op
  - Empty queue → no-op
  - Orphaned-approval drains individually
  - Multiple user-input drain together
  - Filter excludes commands for other sessions
- [ ] `tests/core/RepublicAgent.commandQueue.test.ts` (integration)
  - `submitOperation` returns id, command appears in queue
  - Multiple submissions drain via subscribe trigger
  - Sub-agent completion enqueues task-notification, parent picks it up next idle
  - `'now'` priority command interrupts foreground turn (in supported tool contexts)

## Step 9 — Behavior parity check

- [ ] All existing `Session.test.ts` and `RepublicAgent.test.ts` tests pass unchanged
- [ ] No regression in `tests/core/multi-session.integration.test.ts`
- [ ] No regression in `tests/core/parallel-execution.integration.test.ts`
- [ ] Verify build green for extension/desktop/server platforms
- [ ] Verify lint passes

## Out of scope (08b) — picked up by follow-ons

- Per-mode rate limiting / debouncing (08b-followup)
- Stale-command timeout / expiry (08b-followup)
- EventLog subscription to queue events (08c)
- Migrating `RepublicAgentEngine.eventWaiters` to Mailbox (08a-followup)
- Pasted content / image expansion at enqueue time (browserx UIs handle natively)
- Bridge origin / remote-control filter (no feature)
- Per-session `CommandQueue<T>` factory injection (use `Session` constructor for now)
