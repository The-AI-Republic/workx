# Track 08 Tasks

> **Status (2026-05-14):** Single-phase scope. Phase 2 (EventLog) deferred to
> **[#215](https://github.com/The-AI-Republic/browserx/issues/215)** pending a validated consumer.

See [`design.md`](./design.md) for the architectural rationale and gap analysis.

---

## Phase 1: CommandQueue (replaces `submissionQueue` + `pendingNotifications`)

**Goal:** Priority-ordered, filterable, observable queue in place of the plain array.
**Estimated size:** ~300 LOC new, ~350 LOC deleted (net roughly LOC-neutral, plus new capability).
**Single PR.**

### 1.1 Pre-flight audits

- [ ] **Naming collision audit.** Run `grep -rn "class CommandQueue\|interface CommandQueue\|type CommandQueue\b" src/ --include="*.ts" --include="*.svelte"` — verify no existing symbol named `CommandQueue` in `src/`. If a collision exists, fall back to `MessageQueue<T>` or `SubmissionQueueV2`.
- [ ] **Dead-code re-verification.** Re-run `grep -rn "QueueProcessor\|SubmissionQueue\|EventQueue" src/ --include="*.ts" | grep -v __tests__` to confirm `QueueProcessor.ts` exports remain uninstantiated in production code as of branch-creation date. False positives expected on `RepublicAgent.eventQueue` (different name, same word).

### 1.2 New primitive

- [ ] Create `src/core/queue/types.ts` with `QueuePriority`, `QueuedCommand<T>`, `EnqueueOptions`, `DequeueFilter<T>`. ~30 LOC.
- [ ] Create `src/core/queue/CommandQueue.ts`:
  - [ ] `enqueue(payload, opts)` returns `uuid`. Default priority `'next'` if not specified.
  - [ ] `dequeue(filter?)` finds highest-priority match (linear scan, FIFO within tier). Removes and returns.
  - [ ] `dequeueBatch(filter, maxBatch=10)` returns up to N matching items in priority + FIFO order.
  - [ ] `peek(filter?)` non-destructive variant of `dequeue`.
  - [ ] `remove(uuid)` returns boolean.
  - [ ] `popAll(filter?)` drains all matching.
  - [ ] `clear()` empties queue.
  - [ ] `length` getter.
  - [ ] `subscribe(listener)` — internal `Set<Listener>`, fires on every mutation with frozen snapshot. Returns unsubscribe.
- [ ] Tests in `src/core/queue/__tests__/CommandQueue.test.ts`:
  - [ ] Priority ordering: `now` before `next` before `later`.
  - [ ] FIFO within same priority tier.
  - [ ] `engineId` filter excludes mismatched commands.
  - [ ] `remove(uuid)` and return value.
  - [ ] `popAll(filter)` drains correctly.
  - [ ] `subscribe` fires on enqueue, dequeue, remove, popAll, clear. Returns unsubscribe.
  - [ ] `dequeueBatch` respects maxBatch and filter.
  - [ ] `dequeueBatch` skips non-matching items (does not stop on first non-match if subsequent match exists — claudy semantic).

### 1.3 RepublicAgentEngine wiring

- [ ] In `src/core/engine/RepublicAgentEngine.ts`:
  - [ ] Replace `private submissionQueue: Submission[] = []` (line 27) with `private submissionQueue = new CommandQueue<Submission>()`.
  - [ ] Update `submitOperation(op)` (line 116-126) to call `submissionQueue.enqueue(submission, { priority, engineId })`. Priority derived from op type via a small helper `priorityForOp(op): QueuePriority` (`Interrupt`/`Shutdown`/`ExecApproval` → `'now'`; `UserInput`/`UserTurn`/`ServiceRequest` → `'next'`; default → `'later'`).
  - [ ] Update `processSubmissionQueue()` (line 378-403): loop calls `submissionQueue.dequeue(this.queueFilter())` until empty. `queueFilter()` returns the appropriate filter for main agent vs sub-agent.
  - [ ] Delete `pendingNotifications: string[]` field (line 44).
  - [ ] Delete `drainPendingNotificationsInto(input)` method (line 318-325) and all callers (`run`, `sendFollowUp`).
  - [ ] Modify `enqueueSyntheticUserTurn(text)` (line 299-312):
    - If `parentEngine` is set, call `parentEngine.submissionQueue.enqueue({ type: 'UserInput', items: [{type:'text', text}] }, { priority: 'later', engineId: this.parentEngineId })`.
    - Else (root agent), enqueue into own `submissionQueue` with `priority: 'later'`.
  - [ ] Verify `eventWaiters` array does not depend on the queue type (it's independent — confirm by reading).

### 1.4 Delete dead code

- [ ] Delete `src/core/QueueProcessor.ts` (343 LOC).
- [ ] Delete `src/core/__tests__/QueueProcessor.test.ts`.
- [ ] Re-run `npm run lint && npm run type-check` and `npm test` — all green.

### 1.5 Behavior tests

- [ ] Integration test in `src/core/engine/__tests__/RepublicAgentEngine.queue.test.ts`:
  - [ ] User submits a prompt while a background sub-agent is mid-execution. Sub-agent's `enqueueSyntheticUserTurn` enqueues with `priority: 'later'`. User prompt enqueues with `priority: 'next'`. Drain order: user prompt first, sub-agent notification second.
  - [ ] Sub-agent's `processSubmissionQueue` does not pick up commands meant for main agent (engineId mismatch).
  - [ ] `Interrupt` op enqueued during in-flight tool: queued at `'now'`, picked next iteration, **does not abort the in-flight tool** (consistent with claudy and design intent).
- [ ] Update existing `RepublicAgent.test.ts` and `RepublicAgentEngine.test.ts` for any assertions about `submissionQueue.length` or `pendingNotifications`.

### 1.6 Documentation

- [ ] Brief README at `src/core/queue/README.md` pointing at design doc.
- [ ] Update `src/core/engine/README.md` (if present) to note priority semantics and sub-agent filter.

---

## Cross-cutting tasks

- [ ] Verify `__BUILD_MODE__` (`extension` / `desktop` / `server`) is respected by the new `src/core/queue/` files (pure TS, no platform-specific imports — should be trivial).
- [ ] Update the dependency graph in `.ai_design/agent_improvements/README.md` to reflect that Track 08 is now single-phase with EventLog deferred to [#215](https://github.com/The-AI-Republic/browserx/issues/215).

---

## Deferred (NOT in this track)

| Item | Tracked at | Rationale |
|------|-----------|-----------|
| **EventLog** (former Phase 2) | [#215](https://github.com/The-AI-Republic/browserx/issues/215) | Real architectural gap (claudy uses Datadog/OTel which BrowserX can't reach for local debugging), but no validated consumer today. Lighter-weight in-memory alternative noted in the issue. |
| **MessageBus** (former 08d) | inline in design.md | Stays deferred. Reassess only if a real consumer emerges that none of `ChannelManager`, `ServiceRegistry`, `HookDispatcher`, or `CommandQueue.subscribe` can serve. |
| **Tool-call preemption on `'now'` priority** | not tracked | Out of scope. `'now'` is urgent-but-cooperative (claudy semantic). Adding tool-cancellation plumbing is a separate concern. |
| **`RepublicAgentEngine.eventWaiters` refactor** | not tracked | The other `Array<resolver>` pattern in the engine. Not in scope; revisit if it grows. |
