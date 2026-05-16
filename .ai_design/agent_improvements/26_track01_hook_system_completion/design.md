# Track 26 — Hook System Completion (follow-up to Track 01)

Date: 2026-05-15
Status: OPEN — P1
Follows up: [Track 01 — Hook & Event System](../01_hook_event_system_DONE/design.md) (shipped PR #198)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`)

> Follow-up track. Track 01's design doc is **not** modified. Track 01's core hook system
> genuinely shipped and is wired into all five owning surfaces; these are the residual,
> design-promised items that did not land.

## Verified gaps

### G1 — `TaskCompleted` does not fire on failure/abort (semantic bug)

Track 01 design (design.md:1164-1173) requires `TaskCompleted` to fire once a task "has
either completed successfully **or** terminated with failure/abort." The implementation
fires it only in the success branch (`Session.ts:1883-1891`); the failure/abort path
(`Session.ts:1896`, `onTaskAborted`) never fires it. Hooks observing task termination miss
all non-success terminations.

### G2 — Tool runtime context not provided to hooks (browser-agent-critical)

Track 01 designed a `getToolRuntimeContext` helper populating `tab_id`, `current_url`,
`current_domain`, `cwd` on the PreToolUse/PostToolUse/PostToolUseFailure `HookInput`.
`TurnManager.ts:790-795,840-846,891-896` builds `HookInput` with only
`session_id`/`tool_name`/`tool_input`; the helper does not exist (grep negative). For a
browser automation agent this is the primary use case for hooks — browser-context-aware
hooks currently receive none of the browser context.

### G3 — `HookResult` observability event missing

Track 01 design specifies three observability events; only `HookFired` and `HookBlocked`
ship (`HookDispatcher.ts:182-201`). `HookResult` (design.md:1354,1365-1370) is absent from
`events.ts` (grep negative).

### G4 — `Stop` hook is registrable but never fires

`Stop` is in the hook-event union and `VALID_HOOK_EVENTS` (`types.ts:26`,
`HookRegistry.ts:23`) but no call site fires it (grep: no `fire('Stop'`). Hook authors can
register a `Stop` hook that can never run — misleading.

## Goals

1. Fire `TaskCompleted` on success **and** failure/abort (G1).
2. Add `getToolRuntimeContext` and populate browser/runtime context on tool hook inputs (G2).
3. Either emit a `HookResult` event or formally descope it in Track 01's design (G3).
4. Either wire a `Stop` firing site or remove `Stop` from the Phase-1 union (G4).

## Non-goals

- Phase-2 hook features Track 01 explicitly deferred: prompt/http hook execution, async
  re-entry (`{"async":true}` + `asyncTimeout`) / `AsyncHookRegistry`. Those remain Phase 2.

## Approach

- **G1**: move the `TaskCompleted` fire so it also fires from the abort/failure path in
  `Session.spawnTask()` (around `Session.ts:1894-1898`) — ideally a single `finally`-style
  emission keyed on terminal status so success and failure/abort both notify exactly once.
- **G2**: add `getToolRuntimeContext(session)` deriving `tab_id` (bound session tab),
  `current_url`/`current_domain` (active page for that tab), `cwd` (platform-appropriate);
  merge it into the three tool `HookInput` construction sites in `TurnManager`. Guard for
  no-tab/headless contexts (fields optional).
- **G3**: decide (see Open Questions). If keep: add `HookResult` to `EventMsg` and emit
  per-hook results from `HookDispatcher`. If drop: this follow-up's only G3 deliverable is a
  one-line note added to *this* doc recording the descope (Track 01's doc stays untouched per
  the user's rule).
- **G4**: prefer wiring a real `Stop` firing site at turn-stop in `TurnManager`/
  `RepublicAgent`; if no clear semantics, remove `Stop` from `VALID_HOOK_EVENTS` + union so
  it cannot be registered.

## Risks

- **G2** is the highest-value item but touches the hot tool-dispatch path — context
  derivation must be cheap and must not throw (fail to empty/optional fields).
- **G1** must not double-fire `TaskCompleted` when a task both errors and is then aborted.

## Validation

- G1: unit test — task that fails and task that is aborted each fire exactly one
  `TaskCompleted`; success path unchanged.
- G2: unit test — a PreToolUse hook receives `tab_id`/`current_url`/`current_domain`/`cwd`;
  headless context yields the documented empty/optional shape.
- G3: if kept, dispatcher test asserts a `HookResult` per executed hook.
- G4: if wired, a turn-stop test fires `Stop`; if removed, registering `Stop` is rejected.

## Open questions

1. G3: is `HookResult` worth the event volume, or is `HookFired`+`HookBlocked` sufficient?
   (Recommend: descope unless a consumer needs per-hook result granularity.)
2. G4: what are the precise `Stop` semantics for a browser agent (turn end? user-stop?
   shutdown?) — needed before wiring vs removing.
