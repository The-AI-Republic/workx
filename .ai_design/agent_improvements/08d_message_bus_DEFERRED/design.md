# Track 08d: MessageBus — DEFERRED

> **Status (2026-05-13):** Deferred pending evaluation after 08a, 08b, and 08c land.
> Active PR: none. No work planned.

## Why this is deferred

The original Track 08 design allocated ~860 LOC to a generic topic-based pub/sub
`MessageBus`. The 2026-05-13 audit of browserx + claudy showed three things that make
this likely unnecessary:

1. **`ChannelManager` already routes** (PR #174 merged 2026-03-08).
   `src/core/channels/ChannelManager.ts` (239 LOC) routes submissions from UI channels
   to the agent and dispatches events back. It is not a pub/sub bus, but it covers
   the cross-platform message-routing job that MessageBus would otherwise own.

2. **`HookDispatcher` already does lifecycle events** (PR #198 merged 2026-05-11).
   `src/core/hooks/HookDispatcher.ts` (203 LOC) is the single observation point for
   all hook firings. Track 01 explicitly left it scoped to lifecycle observability,
   not arbitrary topic subscriptions — but for the use cases that motivated 08d
   (tool-call observability, session lifecycle, approval events), it is the right
   tool.

3. **`ServiceRegistry` already does request/response RPC** (PR #174).
   `src/core/channels/ServiceRegistry.ts` (82 LOC) handles dotted-path service calls.
   This is the other half of what a generic MessageBus would cover.

Adding a new `MessageBus` on top would create a third routing layer with overlapping
responsibilities. This is the "speculative abstraction" the global CLAUDE.md rules
warn against — it builds infrastructure for hypothetical future requirements rather
than measured current ones.

## When to revisit

After 08a, 08b, and 08c have all landed (Signal, Mailbox, CommandQueue, EventLog),
reassess the residual gap. Three concrete questions to answer at that point:

1. **Is there a real consumer that wants topic-based pub/sub** which can't be served
   by Signal subscriptions, EventLog `subscribe(sessionId, listener)`, or
   ChannelManager broadcasting?
2. **Are there cross-cutting subscribers** (e.g., a single observer that wants every
   hook + every command + every approval) that EventLog can't already satisfy?
3. **Does the codebase actually have N-to-M topic semantics anywhere**, or is
   everything 1-to-1 (RPC), 1-to-many (events), or many-to-1 (queue drain)?

If the answer to all three is "no" or "not yet," 08d stays deferred indefinitely.
If "yes" emerges from real implementation pressure, this stub becomes the starting
point for a focused design at that time — sized to the actual gap, not the
speculative one.

## What the original 08 design proposed (for reference)

The archived original Track 08 design at
`.ai_design/agent_improvements/08_centralized_message_queue_SPLIT/design.md` proposed:
- 859-line `MessageBus` with topic registry, middleware pipeline, backpressure,
  multi-recipient routing
- Replacement of `RepublicAgent.eventQueue` with `MessageBus` topic
- Wiring of all hook events, command queue, and approval events through bus topics
- `ChannelManager` and `ServiceRegistry` adapted to publish through the bus

That design pre-dated PR #174 and PR #198 landing. With those merged, most of its
job is already done, by other primitives.

## Decision rule

**Don't write the code; don't even firm up the design.** If 08a/b/c land cleanly and
no one says "I wish I had a topic bus" within ~3 months of follow-on work, archive
this stub and update the README to remove 08d entirely.

## See also

- `../08a_signal_mailbox/design.md` — the foundational primitives that 08d would
  have built on
- `../08b_command_queue/design.md` — semantic input queue
- `../08c_event_log/design.md` — observation + audit trail
- `../08_centralized_message_queue_SPLIT/design.md` — original 1515-line design
  (archived)
