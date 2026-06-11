# `src/core/queue/`

Priority-aware command queue used by `RepublicAgentEngine` to order
submissions so user interrupts (`Interrupt`, `ExecApproval`, `Shutdown`)
jump ahead of queued background ops (`Compact`, `AddToHistory`).

See [Track 08 design](../../../.ai_design/agent_improvements/08_centralized_message_queue/design.md)
for rationale, API, and the explicit non-goals list.

## Quick reference

- `CommandQueue<T>` — six methods: `enqueue`, `dequeue`, `peek`, `clear`,
  `length`, `subscribe`.
- `QueuePriority` — three tiers: `'now' | 'next' | 'later'`.
- `priorityForOp(op)` — maps every `EngineOp` variant to its default
  priority. Add a case here when a new variant is introduced.
- Internal: linear-scan `dequeue` (O(n) — queue depth is typically < 5),
  frozen snapshot rebuilt on every mutation, sync notification to
  subscribers.

## What's not here (deferred)

- `engineId` filter on dequeue — per-engine queue isolation already
  prevents cross-agent leaks in WorkX.
- Consecutive-prompt batching — requires a `workload` field on submissions.
- `remove(uuid)` / `popAll(filter)` — no current call site needs them.
- Persistent audit log — tracked in
  [#215](https://github.com/The-AI-Republic/browserx/issues/215).
