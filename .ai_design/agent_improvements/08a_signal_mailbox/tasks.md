# Track 08a: Signal + Mailbox — Tasks

> v1 scope only. ~150 LOC new, ~350 LOC deleted. Single PR.
> Behavior parity with current ApprovalManager is the acceptance bar.

## Step 1 — Signal primitive

- [ ] Create `src/core/signals/signal.ts` (~25 LOC)
  - `export type Signal<Args extends unknown[] = []>` with `subscribe / emit / clear`
  - `export function createSignal<Args>()`
  - **Per-listener try/catch in `emit`** — log via `console.error('[signal] listener threw', err)`; do not rethrow
- [ ] Create `src/core/signals/index.ts` re-export
- [ ] Unit tests `tests/core/signals/signal.test.ts`
  - Subscribe/unsubscribe lifecycle
  - `clear()` removes all listeners
  - One throwing listener does not skip subsequent listeners (regression guard)
  - Unsubscribe-during-emit is safe (Set deletion mid-iteration)
  - Same listener subscribed twice is stored once (Set dedup)

## Step 2 — Mailbox primitive

- [ ] Create `src/core/mailbox/mailbox.ts` (~110 LOC)
  - `export type MailboxMessage` base type (`id`, `timestamp`)
  - `export type ReceiveOptions { timeoutMs?, signal? }`
  - `export class Mailbox<T extends MailboxMessage>`:
    - `send(msg)` — direct-handoff to first matching waiter, else enqueue; predicate-throw rejects bad waiter and continues
    - `poll(fn?)` — non-blocking; uses internal `findSafe` (predicate-throw skips message + logs)
    - `receive(fn?, opts?)` — fast-path on existing match; else add waiter; supports `timeoutMs` and `AbortSignal`
    - `subscribe` — bound delegate to internal `changed.subscribe`
    - `length` and `revision` getters
  - `export class MailboxTimeoutError extends Error`
- [ ] Create `src/core/mailbox/index.ts` re-export
- [ ] Unit tests `tests/core/mailbox/mailbox.test.ts`
  - `send` direct handoff: matching waiter resolves immediately, queue stays empty
  - `send` enqueue when no waiter / no match: message in `queue`, length = 1
  - `poll(predicate)` returns matching message and removes it; returns undefined when no match
  - `receive(predicate)` fast path resolves with already-queued message
  - `receive(predicate)` slow path resolves when matching `send` arrives
  - `receive` with `timeoutMs` rejects with `MailboxTimeoutError` after timeout
  - `receive` with `AbortSignal` rejects with `AbortError` when aborted
  - Aborting a signal that's already aborted before `receive` rejects synchronously
  - Predicate throw in `send` rejects only the bad waiter (not subsequent waiters)
  - Predicate throw in `findSafe` (poll/receive fast path) skips message + logs, returns undefined
  - Multiple waiters with overlapping predicates: FIFO resolution order (first inserted wins)
  - `subscribe` survives destructuring: `const { subscribe } = mailbox; subscribe(...)`
  - `revision` increments on every `send`

## Step 3 — ApprovalManager refactor

- [ ] Read existing `src/core/ApprovalManager.ts` end-to-end (547 LOC)
- [ ] Read existing `tests/core/ApprovalManager.test.ts` — these are the golden tests; must pass unchanged
- [ ] Replace `pendingRequests: Map<string, PendingApproval>` with:
  - `inbox: Mailbox<ApprovalEnvelope>` for response delivery
  - `pendingMeta: Map<string, { request, abort: AbortController }>` for cancel + telemetry only
- [ ] Rewrite `requestApproval(request)`:
  - Policy evaluation unchanged
  - Emit `ApprovalRequested` event unchanged
  - `await inbox.receive(m => m.id === request.id, { timeoutMs, signal })`
  - Catch `MailboxTimeoutError` → emit `ApprovalGranted` with `'Auto-approved after timeout'` reason → return auto-approve response
  - Catch `AbortError` → rethrow (caller decides)
  - `finally { pendingMeta.delete(request.id) }`
- [ ] Rewrite `handleDecision(id, response)`:
  - `inbox.send({ id, timestamp: Date.now(), response })`
  - `approvalHistory.set(id, response)`
  - Emit `ApprovalGranted` or `ApprovalDenied` event (unchanged)
- [ ] Rewrite `cancelRequest(id)`:
  - Look up `pendingMeta.get(id)?.abort.abort()`
  - Existing event emission preserved
- [ ] Run existing `tests/core/ApprovalManager.test.ts` — must pass unchanged. If any test fails, the refactor is wrong, not the test.
- [ ] Add new tests for race conditions:
  - `handleDecision` then `cancelRequest` (decision wins)
  - `cancelRequest` then `handleDecision` (cancel wins, decision is no-op)
  - Concurrent `requestApproval` calls with the same id (should not happen in practice; document behavior)

## Step 4 — Delete dead `QueueProcessor`

- [ ] `grep -r "QueueProcessor\|SubmissionQueue\|EventQueue" src --exclude='*.test.ts' | grep -v 'eventQueue\b'`
  - Confirm only false positives (`RepublicAgent.eventQueue` is a different name)
- [ ] `rm src/core/QueueProcessor.ts`
- [ ] `rm src/core/__tests__/QueueProcessor.test.ts`
- [ ] Run full test suite — no failures expected

## Step 5 — Coverage & docs

- [ ] Verify 80%+ coverage on `src/core/signals/**` and `src/core/mailbox/**`
- [ ] Add short README at `src/core/signals/README.md` and `src/core/mailbox/README.md`
  - 1 paragraph each: what it is, when to use it, pointer to design doc
- [ ] Verify `npm run lint` and `npm test` pass
- [ ] Verify `npm run build` (or equivalent) passes for all platforms (extension/desktop/server)

## Out of scope (08a) — picked up by follow-ons

- Migrating `RepublicAgentEngine.eventWaiters` to Mailbox (08a-followup)
- Wiring `Signal` into Track 07's `agentStateStore` subscribe (Track 07 follow-up)
- CommandQueue using Signal for `queueChanged` (08b)
- EventLog using Signal for log notifications (08c)
- Bounded queue / backpressure on Mailbox (revisit if a consumer needs it)
- Async-listener wrapper (`Promise.resolve(...).catch()`) on Signal — only if an async consumer appears
