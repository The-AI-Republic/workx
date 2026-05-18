# Track 26 — Tasks

Follows up [Track 01](../01_hook_event_system_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — TaskCompleted on all terminations (G1)

- [x] 1.1 Emit `TaskCompleted` from the abort/failure path in `Session.spawnTask()`
      (~`Session.ts:1894-1898`), keyed on terminal status; ensure exactly-once.
- [x] 1.2 Test: failed task and aborted task each fire one `TaskCompleted`; success path
      unchanged.

## Phase 2 — Tool runtime context + per-tool snapshot (G2 + Track 35 overlap)

- [x] 2.1 Add `getToolRuntimeContext(session)` → `{ tab_id, current_url, current_domain,
      cwd }`, non-throwing, optional fields for headless.
- [x] 2.2 Merge it into the 3 tool `HookInput` sites (`TurnManager.ts:790-795,840-846,
      891-896`).
- [x] 2.3 Snapshot matching hooks once per tool execution and reuse that generation for
      PreToolUse, PermissionRequest, PostToolUse, and PostToolUseFailure.
- [x] 2.4 Test: PreToolUse hook receives browser context; headless yields documented shape.
- [x] 2.5 Test: hooks changed between Pre and Post of one tool execution do not affect that
      execution; new hooks apply to the next tool execution.

## Phase 3 — HookResult telemetry (G3)

- [x] 3.1 Add bounded `HookResult` to `EventMsg` / protocol event types.
- [x] 3.2 Emit one `HookResult` per executed hook from `HookDispatcher`, covering success,
      block, permission decision, input update, timeout, and thrown error.
- [x] 3.3 Redact/summarize large hook payloads; do not emit tool output blobs or secrets.
- [x] 3.4 Test: dispatcher emits exactly one bounded result per hook execution.

## Phase 4 — Stop hook wiring (G4)

- [x] 4.1 Wire `Stop` from accepted user/system stop paths (`handleInterrupt`,
      `interruptTask`/`abortTask`, and shutdown-relevant abort path as applicable).
- [x] 4.2 Include session id, optional task/submission id, stop reason, foreground/background,
      and available runtime context in the `Stop` input.
- [x] 4.3 Bound execution so `Stop` hooks cannot hang abort/shutdown.
- [x] 4.4 Test: a stopped turn/task fires `Stop` exactly once; a throwing/slow hook cannot
      veto the stop.

## Phase 5 — Config hook watcher cleanup (G5)

- [x] 5.1 Store the unsubscribe returned by `ConfigHookLoader.watch(...)` on
      `RepublicAgent`.
- [x] 5.2 Invoke that unsubscribe during `RepublicAgent.cleanup()` and clear config-source
      hooks or the registry as appropriate after `SessionEnd`.
- [x] 5.3 Test: after cleanup, emitting `config-changed { section: 'hooks' }` does not
      mutate the cleaned-up agent's `HookRegistry` and does not retain an old listener.

## Exit criteria

- `TaskCompleted` observable on success, failure, and abort.
- Tool hooks receive browser/runtime context.
- `HookResult` shipped as bounded per-hook telemetry.
- `Stop` fires from accepted user/system stop paths.
- Config hook watchers are unsubscribed during agent cleanup.
