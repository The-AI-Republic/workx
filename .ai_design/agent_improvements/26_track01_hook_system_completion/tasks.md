# Track 26 — Tasks

Follows up [Track 01](../01_hook_event_system_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — TaskCompleted on all terminations (G1)

- [ ] 1.1 Emit `TaskCompleted` from the abort/failure path in `Session.spawnTask()`
      (~`Session.ts:1894-1898`), keyed on terminal status; ensure exactly-once.
- [ ] 1.2 Test: failed task and aborted task each fire one `TaskCompleted`; success path
      unchanged.

## Phase 2 — Tool runtime context (G2)

- [ ] 2.1 Add `getToolRuntimeContext(session)` → `{ tab_id, current_url, current_domain,
      cwd }`, non-throwing, optional fields for headless.
- [ ] 2.2 Merge it into the 3 tool `HookInput` sites (`TurnManager.ts:790-795,840-846,
      891-896`).
- [ ] 2.3 Test: PreToolUse hook receives browser context; headless yields documented shape.

## Phase 3 — HookResult decision (G3)

- [ ] 3.1 Decide keep vs descope.
- [ ] 3.2a Keep: add `HookResult` to `EventMsg`; emit per-hook in `HookDispatcher`; test.
- [ ] 3.2b Descope: record the decision in *this* track's design (do not edit Track 01).

## Phase 4 — Stop hook resolution (G4)

- [ ] 4.1 Define `Stop` semantics for a browser agent.
- [ ] 4.2a Wire a `Stop` firing site (turn-stop) + test, or
- [ ] 4.2b Remove `Stop` from `VALID_HOOK_EVENTS` + union; test registration rejected.

## Phase 5 — Config hook watcher cleanup (G5)

- [ ] 5.1 Store the unsubscribe returned by `ConfigHookLoader.watch(...)` on
      `RepublicAgent`.
- [ ] 5.2 Invoke that unsubscribe during `RepublicAgent.cleanup()` and clear config-source
      hooks or the registry as appropriate after `SessionEnd`.
- [ ] 5.3 Test: after cleanup, emitting `config-changed { section: 'hooks' }` does not
      mutate the cleaned-up agent's `HookRegistry` and does not retain an old listener.

## Exit criteria

- `TaskCompleted` observable on success, failure, and abort.
- Tool hooks receive browser/runtime context.
- `HookResult` shipped or explicitly descoped here.
- `Stop` either fires or is unregistrable.
- Config hook watchers are unsubscribed during agent cleanup.
