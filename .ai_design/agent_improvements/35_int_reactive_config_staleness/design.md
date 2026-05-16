# Track 35 — Integration Defect: Reactive Config Changes Don't Reach In-Flight Execution

Date: 2026-05-15
Status: OPEN — P1
Type: Cross-track integration bug
Tracks involved: [Track 07 Centralized State](../07_centralized_state_DONE/design.md) × [Track 11 Parallel Tool Calls](../11_parallel_tool_calls_DONE/design.md) × [Track 01 Hooks](../01_hook_event_system_DONE/design.md)
Source: cross-track integration audit 2026-05-15, independently re-verified against on-disk source on `agent-improvements`.

## Summary

Track 07 made model/config selection reactive. Track 11 and Track 01 both read config at a
*fixed point* (client construction; live hook registry). When config changes mid-session,
two consumers end up acting on a different config generation than expected — a stale
per-client flag, and a mid-tool hook-set swap.

---

## BUG-1 — High: stale `parallelToolCalls` (and all per-client config) after a config change

**Evidence (verified):**
- `ModelClientFactory` caches clients by `cacheKey =
  ${provider}-${selectedModelKey}-${routingType}` (`src/core/models/ModelClientFactory.ts:184`);
  cache hit returns the cached client (`:187`). The key encodes **neither**
  `parallelToolCalls` nor any tools-config input.
- Track 11 resolves `parallelToolCalls` only at construction via
  `resolveParallelToolCalls()` (`ModelClientFactory.ts:227,575`, injected at `:312,325,
  661,673,…`).
- `RepublicAgent` subscribes to `config-changed` and reacts **only** to
  `event.section === 'model'` (`src/core/RepublicAgent.ts:253-255` →
  `handleModelConfigChange:265`). There is **no** `section === 'tools'` handler.
- `modelClientFactory.clearCache()` is called only from the desktop hot-swap path
  (`RepublicAgent.ts:444`), never reached for an extension `tools` config change.

**Bug:** Two concrete failures:
1. Toggling `parallelToolCalls` emits `config-changed` `section:'tools'` — no listener →
   no cache invalidation → the already-built client keeps the **old** flag for the rest of
   the session. The Track 11 feature flag is effectively pinned to its value at first client
   construction for any reused cache entry.
2. Even via the model path: change model A→B (builds B fresh), then back to A → the
   **cached A client** (built before any later config change) is returned, carrying stale
   per-client config (parallelToolCalls, and any other construction-time-resolved setting).

**Fix:** either (a) include the tools-config-derived `parallelToolCalls` (and other
construction-time-resolved inputs) in `cacheKey`, or (b) have `RepublicAgent` also subscribe
to `section: 'tools'` (and any other section that feeds client construction) and call
`modelClientFactory.clearCache()` before re-creating the client. Option (a) is more precise
(only rebuilds affected clients); option (b) is simpler. Add a test: toggle
`parallelToolCalls` mid-session → next turn's client emits the new value.

---

## BUG-2 — Medium: hook registry can be swapped mid-tool (PreToolUse vs PostToolUse)

**Evidence (verified):**
- `AgentConfig.emitChangeEvent` invokes handlers **synchronously**
  (`src/config/AgentConfig.ts` change-emit path).
- Track 01's `ConfigHookLoader.watch` handler synchronously calls `load()` →
  `registry.unregisterBySource('config')` then `registry.registerFromConfig(...)`
  (`src/core/hooks/loaders/ConfigHookLoader.ts:31-36,46-52`) — mutating the **live**
  registry.
- `HookDispatcher.fire` reads matching hooks at call time via
  `this.registry.getMatchingHooks` (`src/core/hooks/HookDispatcher.ts:86`) with **no
  per-turn / per-tool snapshot**.

**Bug:** if a `config-changed` `section:'hooks'` event lands between a tool's
PreToolUse/PermissionRequest and its PostToolUse, that single side-effecting tool execution
is gated by one hook generation and post-processed by another (or vice-versa) — inconsistent
policy for one action. The window is real and is *widened* by concurrent batches
(Track 36 / Track 02 parallel execution interleaves awaits with the event loop).

**Fix:** snapshot the matching hook set once per turn (or per tool execution) so PreToolUse
and PostToolUse for the same tool use the same hook generation. The reload still takes
effect — just at the next turn/tool boundary, not mid-execution.

## Validation

- BUG-1: integration test — start a turn, toggle `parallelToolCalls`, assert the *next*
  turn's request payload reflects the new value; and model A→B→A returns a client with
  current config, not the stale cached one.
- BUG-2: test — fire a `section:'hooks'` change between Pre and Post of one tool execution;
  assert both phases used the same hook generation, and the new hooks apply from the next
  turn.

## Assessed safe (recorded)

- `ApprovalPolicyChanged` (Track 07) vs Track 01 `PermissionRequest`/`PermissionDenied` is
  **not** a read-after-emit race: `ApprovalManager.updatePolicy` mutates `this.policy`
  before emitting (`src/core/ApprovalManager.ts:328-330`), and the gate's `mode` is separate
  state set via `gate.setMode`. (The fact that `gate.mode` and `policy.mode` use different
  enums and are unsynchronized is a *single-track* design concern, out of scope here.)
