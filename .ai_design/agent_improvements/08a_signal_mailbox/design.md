# Track 08a: Signal + Mailbox Primitives

> **Status (2026-05-13):** Implementation-ready. Active PR: none.
> Foundational slice — 08b (CommandQueue) and 08c (EventLog) build on `Signal<T>`,
> and Track 07 (Centralized State) can also use it as its subscribe primitive.
>
> Key decisions resolved (see [Validation Notes 2026-05-13](#validation-notes-2026-05-13)):
> - **Source:** port `claudy/utils/signal.ts` (43 lines) and `claudy/utils/mailbox.ts` (75 lines) verbatim, with two BrowserX-specific additions.
> - **Naming:** `Signal<T>` and `Mailbox<T>` — audited 2026-05-13, no collisions in `src/`.
> - **Two safety additions** browserx adds beyond claudy: per-listener try/catch in `Signal.emit` (fixes a documented claudy pain point); `timeout` overload on `Mailbox.receive` (claudy has no timeouts; ApprovalManager already needs them).
> - **First consumer:** refactor `ApprovalManager.pendingRequests: Map<id, {resolver}>` to `Mailbox<ApprovalResponse>`. Behavior parity required.
> - **Bonus cleanup:** delete `src/core/QueueProcessor.ts` (343 lines, dead code, never instantiated). Audited 2026-05-13.
> - **v1 size:** ~150 LOC new, ~350 LOC deleted. Single PR.

## Problem

`ApprovalManager` (`src/core/ApprovalManager.ts:80, 142`) tracks pending approvals as `Map<string, PendingApproval>`, where each entry stores a captured `resolver: (response) => void` from a `Promise` constructor. This is the "manual Promise/resolver registry" pattern.

It works but has known costs:
- Every consumer that needs async handshake semantics has to invent the same pattern again. `RepublicAgentEngine.eventWaiters: Array<(event) => void>` (`src/core/engine/RepublicAgentEngine.ts:30`) is a second instance.
- Cleanup is manual and error-prone: timeouts, cancellations, and race conditions all require explicit branching that mutates the map.
- There's no shared timeout primitive — each use site implements its own `Promise.race` against `setTimeout`.
- Future async-handshake needs (sub-agent spawn handoffs, scheduled-task → main-thread acknowledgments, plan-mode confirmation flows) will each re-implement the same pattern.

`Signal` and `Mailbox` are the two small primitives that turn this whole class of code into one-liners.

## What Claudy Does

### Signal — `claudy/utils/signal.ts` (verbatim, 43 lines incl. comments)

```typescript
/**
 * Tiny listener-set primitive for pure event signals (no stored state).
 *
 * Collapses the ~8-line `const listeners = new Set(); function subscribe(){…};
 * function notify(){for(const l of listeners) l()}` boilerplate that was
 * duplicated ~15× across the codebase into a one-liner.
 */
export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() { listeners.clear() },
  }
}
```

Used in **13 places** in claudy (research 2026-05-13):
QueryGuard state changes, dynamic skill load completion, fastMode cooldown, Slack channel cache invalidation, file-suggestion partial→full upgrade, useTasksV2 store, claudeCodeHints UI gate, **messageQueueManager** (consumed by 08b), tasks.ts file-watch sync, classifierApprovals state, skillChangeDetector chokidar events, GrowthBook flag refresh, plus Mailbox's internal `changed` notifier.

**Documented claudy pain point:** `Signal.emit()` has **no per-listener try/catch**. If a listener throws, subsequent listeners are skipped. Two files in claudy work around this with a `callSafe` wrapper:
- `loadSkillsDir.ts:839-850` — wraps subscribe in try/catch
- `growthbook.ts:109-123` — wraps with `Promise.resolve(...).catch()` for async safety

The comment in `loadSkillsDir.ts` explicitly says: *"createSignal.emit() has no per-listener try/catch."* — i.e., a known smell, not a deliberate design choice.

### Mailbox — `claudy/utils/mailbox.ts` (verbatim, 75 lines)

```typescript
import { createSignal } from './signal.js'

export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

export type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}

type Waiter = {
  fn: (msg: Message) => boolean
  resolve: (msg: Message) => void
}

export class Mailbox {
  private queue: Message[] = []
  private waiters: Waiter[] = []
  private changed = createSignal()
  private _revision = 0

  get length(): number { return this.queue.length }
  get revision(): number { return this._revision }

  send(msg: Message): void {
    this._revision++
    const idx = this.waiters.findIndex(w => w.fn(msg))
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0]
      if (waiter) {
        waiter.resolve(msg)
        this.notify()
        return
      }
    }
    this.queue.push(msg)
    this.notify()
  }

  poll(fn: (msg: Message) => boolean = () => true): Message | undefined {
    const idx = this.queue.findIndex(fn)
    if (idx === -1) return undefined
    return this.queue.splice(idx, 1)[0]
  }

  receive(fn: (msg: Message) => boolean = () => true): Promise<Message> {
    const idx = this.queue.findIndex(fn)
    if (idx !== -1) {
      const msg = this.queue.splice(idx, 1)[0]
      if (msg) {
        this.notify()
        return Promise.resolve(msg)
      }
    }
    return new Promise<Message>(resolve => {
      this.waiters.push({ fn, resolve })
    })
  }

  subscribe = this.changed.subscribe

  private notify(): void { this.changed.emit() }
}
```

**The clever bit:** `send` checks waiters *first*. If a `receive(predicate)` is already pending and the predicate matches the inbound message, the waiter resolves immediately — the message is never queued. This is the "direct handoff" optimization. If no waiter matches, the message is enqueued and any future `poll`/`receive` finds it.

**Used in only 1 place** in claudy: `context/mailbox.tsx:15` — a single React Context singleton consumed by `useMailboxBridge`. So the *primitive* is more general than its single use suggests.

**Three claudy gaps** that browserx has to fix (or it won't replace `ApprovalManager`'s timeout):
1. `Mailbox.receive()` has **no timeout** — caller waits forever. ApprovalManager today defaults to a 600s auto-approve timeout; we cannot regress that.
2. **No `AbortSignal`** support on `receive`. Cancelling an approval mid-flight (user navigated away, session ended) requires manual queue cleanup.
3. **Predicate errors propagate uncaught.** A throwing predicate in `findIndex` corrupts the receive flow.

## BrowserX Adaptations

### Signal — port verbatim, plus per-listener try/catch

```typescript
// src/core/signals/signal.ts
export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(...args) {
      for (const listener of listeners) {
        try {
          listener(...args)
        } catch (err) {
          // One bad listener does not silence siblings. Claudy's gap; we close it.
          console.error('[signal] listener threw', err)
        }
      }
    },
    clear() { listeners.clear() },
  }
}
```

Trade-off acknowledged: swallowing the error inside `emit` hides bugs from the *emitter's* perspective. The alternative — letting throws propagate and skip siblings — is strictly worse (claudy's two `callSafe` workarounds prove the point). We go with the safer default and rely on `console.error` (eventually wired into 08c EventLog) for visibility.

### Mailbox — port verbatim, plus `timeout` and `signal` on `receive`

```typescript
// src/core/mailbox/mailbox.ts
import { createSignal } from '../signals/signal'

export type MailboxMessage = {
  id: string
  timestamp: number
  // Payload type is tracked by Mailbox<T>'s type parameter, not a fixed source enum.
  // BrowserX supports approval responses, sub-agent results, scheduled-task acks, etc. —
  // narrower than claudy's open-ended 'user'|'teammate'|'system'|'tick'|'task'.
}

export type ReceiveOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export class Mailbox<T extends MailboxMessage> {
  private queue: T[] = []
  private waiters: Array<{ fn: (msg: T) => boolean; resolve: (msg: T) => void; reject: (err: Error) => void }> = []
  private changed = createSignal()
  private _revision = 0

  get length(): number { return this.queue.length }
  get revision(): number { return this._revision }

  send(msg: T): void {
    this._revision++
    // Try direct handoff to the first waiter whose predicate matches.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]
      let matched = false
      try {
        matched = w.fn(msg)
      } catch (err) {
        // Predicate threw — drop this waiter, reject its promise, continue scanning.
        this.waiters.splice(i, 1)
        w.reject(err instanceof Error ? err : new Error(String(err)))
        i--
        continue
      }
      if (matched) {
        this.waiters.splice(i, 1)
        w.resolve(msg)
        this.changed.emit()
        return
      }
    }
    this.queue.push(msg)
    this.changed.emit()
  }

  poll(fn: (msg: T) => boolean = () => true): T | undefined {
    const idx = this.findSafe(fn)
    if (idx < 0) return undefined
    return this.queue.splice(idx, 1)[0]
  }

  receive(fn: (msg: T) => boolean = () => true, opts: ReceiveOptions = {}): Promise<T> {
    // Fast path: matching message already in queue.
    const idx = this.findSafe(fn)
    if (idx >= 0) {
      const msg = this.queue.splice(idx, 1)[0]!
      this.changed.emit()
      return Promise.resolve(msg)
    }

    return new Promise<T>((resolve, reject) => {
      const waiter = { fn, resolve, reject }
      this.waiters.push(waiter)

      const cleanup = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
      }

      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        const t = setTimeout(() => {
          cleanup()
          reject(new MailboxTimeoutError(opts.timeoutMs!))
        }, opts.timeoutMs)
        // Resolve/reject hooks both clear the timer.
        const origResolve = waiter.resolve
        const origReject = waiter.reject
        waiter.resolve = (m) => { clearTimeout(t); origResolve(m) }
        waiter.reject = (e) => { clearTimeout(t); origReject(e) }
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          cleanup()
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        opts.signal.addEventListener('abort', () => {
          cleanup()
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      }
    })
  }

  subscribe = this.changed.subscribe.bind(this.changed)

  private findSafe(fn: (msg: T) => boolean): number {
    for (let i = 0; i < this.queue.length; i++) {
      try {
        if (fn(this.queue[i]!)) return i
      } catch (err) {
        // Predicate threw on a queued message — leave the message, log, and skip.
        console.error('[mailbox] predicate threw on queued message', err)
      }
    }
    return -1
  }
}

export class MailboxTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Mailbox.receive() timed out after ${timeoutMs}ms`)
    this.name = 'MailboxTimeoutError'
  }
}
```

Differences from claudy that matter:
- **Generic over `T`** instead of a fixed `Message` shape. `Mailbox<ApprovalResponse>`, `Mailbox<SubAgentResult>`, etc. compose better with TypeScript.
- **`timeoutMs` and `signal` on `receive`** — required for ApprovalManager parity.
- **Predicate error handling** in both `send` and `findSafe` — drops the waiter (rejecting its promise) rather than corrupting state.
- **Subscriber bind** — `this.changed.subscribe.bind(this.changed)` so `mailbox.subscribe` survives destructuring (claudy assigns the unbound method, which works because of how it's called).

## ApprovalManager Refactor

The whole point of 08a is that this becomes a one-line replacement.

### Before (current `src/core/ApprovalManager.ts:80, 141-143`)

```typescript
this.pendingRequests = new Map<string, PendingApproval>()
// ...
const userDecisionPromise = new Promise<ApprovalResponse>((resolve) => {
  pendingApproval.resolver = resolve  // captured into the Map entry
})

if (timeout > 0) {
  const timeoutPromise = new Promise<ApprovalResponse>((resolve) => {
    pendingApproval.timeoutId = setTimeout(() => {
      // ...auto-approve dance...
      resolve(timeoutResponse)
    }, timeout)
  })
  return Promise.race([userDecisionPromise, timeoutPromise])
}
return userDecisionPromise
```

`PendingApproval` carries `{ request, timestamp, timeRemaining, resolved, resolver?, timeoutId? }`. `handleDecision` and `cancelRequest` both have to walk the map, find the entry, clear the timeout, mark resolved, and call the resolver.

### After (with Mailbox)

```typescript
type ApprovalEnvelope = {
  id: string                // mirrors MailboxMessage.id; equals request.id
  timestamp: number
  response: ApprovalResponse
}

private readonly inbox = new Mailbox<ApprovalEnvelope>()
private readonly pendingMeta = new Map<string, { request: ApprovalRequest; abort: AbortController }>()

async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
  const policyDecision = this.evaluatePolicy(request)
  if (policyDecision) return policyDecision

  const timeout = request.timeout ?? this.policy.timeout ?? 600_000
  const abort = new AbortController()
  this.pendingMeta.set(request.id, { request, abort })

  this.emitEvent({ /* ApprovalRequested as before */ })

  try {
    const env = await this.inbox.receive(
      (m) => m.id === request.id,
      timeout > 0 ? { timeoutMs: timeout, signal: abort.signal } : { signal: abort.signal },
    )
    return env.response
  } catch (err) {
    if (err instanceof MailboxTimeoutError) {
      // Auto-approve on timeout — same behavior as today
      const response = this.buildAutoApproveResponse(request, 'Auto-approved after timeout')
      this.emitEvent({ /* ApprovalGranted with reason */ })
      this.approvalHistory.set(request.id, response)
      return response
    }
    throw err  // AbortError or unexpected
  } finally {
    this.pendingMeta.delete(request.id)
  }
}

handleDecision(id: string, response: ApprovalResponse): void {
  this.inbox.send({ id, timestamp: Date.now(), response })
  this.approvalHistory.set(id, response)
}

cancelRequest(id: string): void {
  const meta = this.pendingMeta.get(id)
  if (meta) meta.abort.abort()
}
```

What collapses:
- The `resolver`/`timeoutId` fields disappear.
- The 30+ lines of manual `Promise.race` setup vanish.
- Cancellation reuses `AbortController` — standard primitive, no custom map walk.
- `handleDecision` becomes one `send()` call. Mailbox handles the direct-handoff to the waiting `receive()` — same semantics as today.

What's preserved (behavior parity):
- Auto-approve on timeout with `'Auto-approved after timeout'` reason — verified.
- All four event emissions: `ApprovalRequested`, `ApprovalGranted`, `ApprovalDenied`, `ApprovalAutoApproved` — preserved.
- `approvalHistory` map — preserved unchanged.
- Track 01 hook integration in `ApprovalGate` (`src/core/approval/ApprovalGate.ts:215, 379`) — unchanged.

## Bonus Cleanup: Delete `QueueProcessor.ts`

Audit 2026-05-13: `src/core/QueueProcessor.ts` (343 lines) defines `PriorityQueue<T>`, `SubmissionQueue extends PriorityQueue<Submission>`, `EventQueue extends PriorityQueue<Event>`, and a `QueueProcessor` orchestrator. **None of these classes are instantiated anywhere in the codebase** other than its own colocated tests (`src/core/__tests__/QueueProcessor.test.ts`).

08b will introduce `CommandQueue<T>` with claudy-shaped semantics, which is a cleaner foundation than retrofitting `PriorityQueue<T>`. Carrying both invites future drift.

Action in this PR:
- Delete `src/core/QueueProcessor.ts`
- Delete `src/core/__tests__/QueueProcessor.test.ts`
- Verify no external references via `grep -r "QueueProcessor\|SubmissionQueue\|EventQueue" src` (then handle the false positives — `RepublicAgent.eventQueue` is a different name)

## Naming & Collisions

Audited 2026-05-13 against the codebase:

| Name | Status | Verdict |
|------|--------|---------|
| `Signal` (export) | Not used (`AbortSignal` is fully qualified, native) | **Use** |
| `createSignal` | Not used | **Use** |
| `Mailbox` (class) | Not used | **Use** |
| `MailboxMessage` | Not used | **Use** |
| `MailboxTimeoutError` | Not used | **Use** |
| `src/core/signals/` (directory) | Does not exist | **Create** |
| `src/core/mailbox/` (directory) | Does not exist | **Create** |

## v1 Plan (this PR — ~150 LOC new, ~350 LOC deleted, single PR)

**Step 1 — Signal primitive** (`src/core/signals/signal.ts`, ~25 lines)
- Port claudy's `createSignal`, add per-listener try/catch in `emit`.
- Export `Signal<T>` and `createSignal<T>()`.

**Step 2 — Mailbox primitive** (`src/core/mailbox/mailbox.ts`, ~110 lines)
- Generic `Mailbox<T extends MailboxMessage>` with `send`, `poll`, `receive`, `subscribe`.
- `receive(fn, { timeoutMs, signal })` — adds timeout + AbortSignal.
- Predicate-throw safety in `send` and `findSafe`.
- `MailboxTimeoutError` subclass.

**Step 3 — ApprovalManager refactor** (`src/core/ApprovalManager.ts`)
- Replace `pendingRequests: Map<string, PendingApproval>` with `inbox: Mailbox<ApprovalEnvelope>` + `pendingMeta: Map<string, {request, abort}>`.
- Rewrite `requestApproval`, `handleDecision`, `cancelRequest`.
- Preserve all existing event emissions and `approvalHistory` behavior.
- Net: -80 LOC.

**Step 4 — Delete dead `QueueProcessor`**
- `rm src/core/QueueProcessor.ts src/core/__tests__/QueueProcessor.test.ts`
- Net: -350 LOC.

**Step 5 — Tests** (`tests/core/signals/`, `tests/core/mailbox/`)
- Signal: subscribe/unsub/clear; per-listener try/catch (one throws, others fire); unsubscribe-during-emit safety.
- Mailbox: `send` direct-handoff; `send` enqueue when no match; `poll` non-blocking; `receive` fast path; `receive` waits then resolves; timeout fires `MailboxTimeoutError`; abort fires `AbortError`; predicate throw rejects waiter or skips message.
- ApprovalManager: full behavior parity — golden tests around timeout, decision, cancel, policy auto-approve. Reuse existing `ApprovalManager.test.ts`.

**Step 6 — Coverage & docs**
- 80%+ coverage on `src/core/signals/**` and `src/core/mailbox/**`.
- Short README in each directory pointing at design doc.

## Follow-on (NOT in this PR)

| Track | Scope | Depends on |
|-------|-------|------------|
| **08a-followup** | Migrate other manual resolver patterns to Mailbox: `RepublicAgentEngine.eventWaiters` (`engine/RepublicAgentEngine.ts:30`), any future plan-mode confirmation flow | 08a v1 |
| **07-fanout** | Use `Signal<T>` as the subscribe primitive in `agentStateStore` (replaces ad-hoc `Set<Listener>`) | 07 v1 |
| **08b** | CommandQueue uses `Signal` for `queueChanged` notify | 08a v1 |
| **08c** | EventLog uses `Signal` for log-changed notifications | 08a v1 |

## Risks

- **Behavior parity in ApprovalManager.** The refactor must preserve: (a) auto-approve on timeout with the exact same reason string; (b) all four event emissions in the right order; (c) `approvalHistory` writes; (d) the `cancelRequest` path. Mitigation: the existing `ApprovalManager.test.ts` becomes the golden test set — must pass unchanged.
- **Per-listener try/catch hides bugs.** A throwing listener silently logs to console; the emitter cannot tell. Mitigation: 08c will route these to EventLog with a structured error event. Until then, `console.error` is the visibility path.
- **`AbortSignal` is browser/Node native.** Tauri's WebView and the Chrome extension service worker both support it. Verified in Track 02 codebase. No polyfill needed.
- **Deleting `QueueProcessor.ts` removes dead `PriorityQueue<T>`.** If any in-flight branch depends on it, they'll fail to merge. Mitigation: the audit confirms no `src/` reference; if a future PR reintroduces a need, 08b's `CommandQueue<T>` is the better answer anyway.

## Validation Notes (2026-05-13)

Re-validated against current claudy source AND audited the browserx side. Two parallel research probes ran 2026-05-13.

### Claudy findings

- **Signal source** is exactly 43 lines including comments. Used in 13 distinct files. Two of those (`loadSkillsDir.ts:839-850`, `growthbook.ts:109-123`) implement `callSafe` wrappers because `emit()` has no per-listener try/catch — explicitly called out as a limitation in the comments. We close this gap in our port.
- **Mailbox source** is exactly 75 lines. Used in only one place (`context/mailbox.tsx:15` — a React Context singleton). The primitive is more general than the use case; we benefit from porting it now even if our first use is just ApprovalManager.
- **Mailbox has no timeout, no AbortSignal, and no predicate-error handling.** All three are real gaps that ApprovalManager would regress without. We add all three.
- **Mailbox's "direct handoff" pattern** (`send` checks waiters before enqueueing) is the killer feature — it makes `await mailbox.receive(p)` perform identically to `await new Promise(r => map.set(id, r))`, with no map cleanup.
- **Order of waiters resolved when multiple match:** FIFO by waiter insertion order (claudy's `findIndex` returns the first match). Our port preserves this.

### BrowserX-side audit findings

- `ApprovalManager` is **547 lines**, with the resolver-storage pattern at line 142 inside a `Promise` constructor. `pendingRequests: Map<string, PendingApproval>` at line 80. Default timeout 600s (`600_000`), configurable per-request. Four event emissions (Requested/Granted/Denied/AutoApproved) all preserved.
- `ApprovalGate` (`src/core/approval/ApprovalGate.ts:215, 379`) **was modified by PR #198** (Track 01) to fire `PermissionRequest` and `PermissionDenied` hooks pre/post approval. Our refactor leaves `ApprovalGate` untouched — the `requestApproval` contract is preserved.
- `RepublicAgentEngine.eventWaiters: Array<(event) => void>` at line 30 is a **second instance** of the same manual-resolver pattern. Listed as 08a-followup target; not in v1 to keep this PR scoped.
- `QueueProcessor.ts` is **343 lines, never instantiated** in production code. Only its own test file references it. Safe to delete.
- **All four naming choices clear:** `Signal`, `Mailbox`, `MailboxMessage`, `MailboxTimeoutError` — no internal collisions, no Web platform globals (`AbortSignal` is fully qualified, no clash).
- `src/core/signals/` and `src/core/mailbox/` directories do not exist; safe to create.

### Decisions resolved

1. **Add per-listener try/catch in `Signal.emit`.** Closes the documented claudy gap; trade-off accepted (logs over throws).
2. **Add `timeoutMs` and `signal` to `Mailbox.receive`.** Required for ApprovalManager behavior parity (600s default auto-approve).
3. **Add predicate-throw safety in `Mailbox.send` and internal `findSafe`.** Drop the bad waiter, log the queue-side throw, continue.
4. **Generic `Mailbox<T>`** instead of fixed `Message`. Better TS ergonomics for `Mailbox<ApprovalResponse>` and future consumers.
5. **Refactor ApprovalManager but don't touch ApprovalGate.** Scope contains the blast radius.
6. **Delete `QueueProcessor.ts` in same PR.** Cleanup pays for itself.

### Open items deliberately deferred

- Migrating `RepublicAgentEngine.eventWaiters` (08a-followup)
- Wiring `Signal` into `agentStateStore` (Track 07 follow-up)
- Bounded queue size on Mailbox with drop policy (revisit if any consumer surfaces a real backpressure problem)
- Per-listener async error handling (`Promise.resolve(...).catch()` wrapper) — only if an async-listener consumer appears

Sources:
- Claudy: `utils/signal.ts` (43 LOC), `utils/mailbox.ts` (75 LOC), `utils/loadSkillsDir.ts:839-850` (callSafe pattern), `utils/growthbook.ts:109-123` (async callSafe pattern), `context/mailbox.tsx:15` (sole call site).
- BrowserX: `src/core/ApprovalManager.ts` (547 LOC, resolver at L142), `src/core/approval/ApprovalGate.ts:215, 379` (PR #198 hook integration), `src/core/engine/RepublicAgentEngine.ts:30` (second resolver pattern), `src/core/QueueProcessor.ts` (343 LOC, dead).
