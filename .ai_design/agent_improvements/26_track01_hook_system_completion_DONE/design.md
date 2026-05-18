# Track 26 — Hook System Completion (follow-up to Track 01)

Date: 2026-05-15
Status: READY TO IMPLEMENT — P1 (decisions locked 2026-05-18)
Follows up: [Track 01 — Hook & Event System](../01_hook_event_system_DONE/design.md) (shipped PR #198)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`)

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

### G5 — Config hook watcher is never unsubscribed on agent cleanup

`ConfigHookLoader.watch(...)` returns an unsubscribe function, but `RepublicAgent.initialize()`
calls it and discards the return value (`RepublicAgent.ts:207-209`). `RepublicAgent.cleanup()`
fires `SessionEnd`, disposes the engine, clears the tool registry, and disposes the platform
adapter (`RepublicAgent.ts:1210-1235`), but never unregisters the config-change listener and
never clears config-source hooks. A cleaned-up agent can therefore leave a stale hook reload
listener attached to `AgentConfig`, keeping the old `HookRegistry` reachable and mutating it
on later `section:'hooks'` changes.

## Goals

1. Fire `TaskCompleted` on success **and** failure/abort (G1).
2. Add `getToolRuntimeContext` and populate browser/runtime context on tool hook inputs (G2).
3. Emit a bounded per-hook `HookResult` observability event (G3).
4. Wire `Stop` as a real user/system stop lifecycle hook (G4).
5. Store and invoke the config-hook watcher unsubscribe during agent cleanup (G5).

## Non-goals

- Phase-2 hook features Track 01 explicitly deferred: prompt/http hook execution, async
  re-entry (`{"async":true}` + `asyncTimeout`) / `AsyncHookRegistry`. Those remain Phase 2.

## Implementation decisions locked 2026-05-18

1. **Keep `HookResult`.** BrowserX should move toward a Claudy-grade hook surface, so per-hook
   result/progress observability is useful. The v1 event is metadata-bounded: hook id/name,
   event name, source, status, duration, blocked/permission/update flags, and error summary.
   It must not emit large tool outputs, full hook stdout, or secrets.
2. **Wire `Stop`.** `Stop` means "a running turn/task was asked to stop by the user or by a
   system lifecycle path." It fires from the accepted stop/abort path after the stop request
   is accepted and before/while abort propagation begins. It is observability/policy-notify
   only in v1: it cannot veto the stop and it must be bounded so shutdown/abort cannot hang.
   If a later product wants a vetoable stop hook, that is a new track.
3. **Snapshot hooks per tool execution.** A single tool call must use one hook generation for
   PreToolUse, PermissionRequest, PostToolUse, and PostToolUseFailure. Config reloads apply
   to the next tool execution, not halfway through the current one.
4. **Keep Track 26 focused.** The broader Claudy-inspired hook expansion is tracked in
   GitHub issue #248. This track implements the concrete completion items that unblock that
   larger direction.

## Approach

- **G1**: move the `TaskCompleted` fire so it also fires from the abort/failure path in
  `Session.spawnTask()` (around `Session.ts:1894-1898`) — ideally a single `finally`-style
  emission keyed on terminal status so success and failure/abort both notify exactly once.
- **G2**: add `getToolRuntimeContext(session)` deriving `tab_id` (bound session tab),
  `current_url`/`current_domain` (active page for that tab), `cwd` (platform-appropriate);
  merge it into the three tool `HookInput` construction sites in `TurnManager`. Guard for
  no-tab/headless contexts (fields optional).
- **G3**: add `HookResult` to `EventMsg` and emit a bounded event from `HookDispatcher` for
  every executed hook. Emit one result for success, block, permission decision, input update,
  timeout, and thrown error. Redact or summarize any large payloads.
- **G4**: wire `Stop` from the accepted stop paths (`RepublicAgent.handleInterrupt`,
  `Session.interruptTask`/`abortTask`/shutdown-relevant abort path as applicable). The hook
  receives the session id, optional task/submission id, reason, platform/runtime context, and
  whether the stopped task was foreground/background. It cannot cancel the stop.
- **G5**: keep the unsubscribe returned by `ConfigHookLoader.watch` on `RepublicAgent`; call
  it from `cleanup()` before clearing agent-owned state. Also clear config-source hooks or the
  whole `HookRegistry` if no other cleanup consumer needs it after `SessionEnd`.

## Risks

- **G2** is the highest-value item but touches the hot tool-dispatch path — context
  derivation must be cheap and must not throw (fail to empty/optional fields).
- **G1** must not double-fire `TaskCompleted` when a task both errors and is then aborted.

## Validation

- G1: unit test — task that fails and task that is aborted each fire exactly one
  `TaskCompleted`; success path unchanged.
- G2: unit test — a PreToolUse hook receives `tab_id`/`current_url`/`current_domain`/`cwd`;
  headless context yields the documented empty/optional shape.
- G3: dispatcher test asserts a bounded `HookResult` per executed hook.
- G4: a turn-stop/abort test fires `Stop` exactly once and cannot be vetoed by a hook.
- G5: test — initialize then cleanup an agent, emit `config-changed {section:'hooks'}`, and
  assert the cleaned-up registry is not reloaded/mutated and the config listener count drops.
