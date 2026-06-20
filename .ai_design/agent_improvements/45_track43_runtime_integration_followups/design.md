# Track 45 — Apple Pi Runtime: real-sidecar integration + verification gaps (follow-up to Track 43)

Date: 2026-05-20 (revised 2026-05-20 after implementation-readiness audit)
Status: OPEN — P1
Follows up: [Track 43 — Apple Pi Runtime Decoupling](../43_apple_pi_runtime_decoupling_DONE/design.md) (shipped PRs #246 + #255)

> Follow-up track. Track 43's design doc is **not** modified. This track
> closes the three verification gaps that remained after the Track 43
> cutover landed. Lower-priority items from Track 43's annotations
> (frame-schema consolidation, per-feature bootstrap parity assertion,
> direct Rust→runtime deeplink push frame, relay round-trip test,
> crash/restart soak, full functional turn verification) are
> intentionally **not** in scope here — they are opportunistic refactors
> or derivatives that can be picked up as PR-sized improvements
> without their own track.

## Why this track exists

After PR #255 the desktop **runs** on the runtime sidecar end-to-end:
the cuttable surface (storage providers, MCP/Node ports, UI cutover,
OAuth, control bridges, packaging script self-test) is shipped and the
unit/contract test suite is green.

What is **not** proven by today's CI:

1. **No CI ever spawns the real Apple Pi desktop sidecar.** The
   existing `src/desktop-runtime/parity/__tests__/scenarios.test.ts`
   registers two fake bindings that both drain from
   `SCENARIO_EVENT_SEQUENCES` — `JSON.stringify(X) === JSON.stringify(X)`.
   Nothing in CI launches `node tauri/sidecar/desktop-runtime/index.mjs`
   and confirms even the protocol/handshake/lifecycle works.
   See `43.../tasks.md:86`.
2. **Rust supervisor lifecycle untested.**
   `tauri/src/runtime_supervisor.rs` handles spawn, handshake, bounded
   restart backoff (`RESTART_BASE_MS = 500ms`, `RESTART_MAX_MS = 30s`,
   `MAX_RESTART_ATTEMPTS = 10`), graceful shutdown
   (`SHUTDOWN_GRACE = 5s`), forced kill, orphan cleanup, stderr drain.
   None has directed `cargo test`; only helper-level coverage exists.
   See `43.../tasks.md:113`.
3. **`diagnostics.recentStderr` is a stub.**
   `runtime_supervisor.rs:298-305` returns `{ "lines": [] }` so callers
   don't break, but no buffer feeds it.
   See `43.../tasks.md:109`.

The release-engineer hand-offs (three-OS `tauri:build` smoke, multi-OS
keychain read-through, resource footprint, startup latency, updater
verification) remain **out of scope** — they are not code work and
continue to be owned by release at tag time per Track 43 Phase 4.

## A note on what this track does NOT attempt

The original Track 43 parity scaffolding (`parity/scenarios.ts` +
`SCENARIO_EVENT_SEQUENCES`) is broken-by-construction for use against
the real runtime:

- The scenario Ops use `{ type: 'UserInput', items: [{ type: 'Text', text }] }`
  with **uppercase** `'Text'` and an extra envelope, then bypass the
  type check with `as unknown as Op`. The real `InputItem` discriminant
  is **lowercase** `'text'` (`src/core/protocol/types.ts:353`).
- The scenarios omit `context.sessionId`, which `ServerAgentBootstrap`
  rejects (`src/server/agent/ServerAgentBootstrap.ts:428` — hard error
  "No sessionId in submission context").
- The canonical event sequences contain synthetic placeholders
  (`text: 'hi back'`, `turnId: 't-1'`, `evt-${Math.random()}`,
  hardcoded `sessionId: 'session-test'`). The real sidecar would emit
  real model output through `RepublicAgent`, real session IDs, etc.
  Direct equality will never pass.

**Fixing the scaffolding into real fixtures requires a deterministic
agent stack** (fake model client, fake services, fake storage) and is
significantly bigger than the three-goal scope of this track. That work
should land as its own track when it's prioritized. Track 45 takes the
narrower-but-realizable approach below.

## Goals

### Goal 1 — Spawned-sidecar protocol & lifecycle smoke test

Build a CI integration test that spawns the **real** desktop runtime
sidecar (the Apple Pi runtime) and asserts the *protocol* and
*lifecycle* work end-to-end. Does **not** drive UserInput ops, does
**not** depend on `SCENARIO_EVENT_SEQUENCES`, does **not** rely on
deterministic agent behavior.

What this test proves:

- The sidecar process can be built and launched outside Tauri.
- The handshake (`hello` → `hello-ok` with matching nonce +
  `protocolVersion`) completes.
- A control-frame round-trip works against a real handler — pick a
  side-effect-free control request such as
  `config.get` with a known key — and assert the matching
  `control-response`.
- Graceful shutdown: the test sends the `shutdown` frame and the child
  exits within `SHUTDOWN_GRACE` (5s), with the supervisor's expected
  exit semantics.

What this test does **not** prove (deliberately out of scope):

- That UserInput ops emit specific event sequences.
- That the agent stack (`RepublicAgent`, model clients, MCP, scheduler,
  auth) is functionally correct in the sidecar context. That's a
  separate, larger track gated on building deterministic agent
  fixtures.

**Launch shape** (test-side, not the production Rust supervisor):

- Sidecar entry: `tauri/sidecar/desktop-runtime/index.mjs` — built by
  `npm run build:desktop-runtime-sidecar`. Not a self-contained
  executable; runs under Node.
- Spawn: `node <path-to-index.mjs>` with env:
  - `APPLEPI_RUNTIME_PROFILE=desktop-runtime`
  - `APPLEPI_DESKTOP_RUNTIME_ALLOW_DEV_HOST=true`
  - `APPLEPI_DESKTOP_CONFIG_DIR=<tmpdir created per test>` so
    `createDevDesktopRuntimeHost()` (`src/desktop-runtime/host.ts:46-90`)
    builds a host pointing at a clean throwaway location.
- Handshake (caller side):
  send `{ "type": "hello", "nonce": <uuid>, "protocolVersion": 1 }`,
  wait for `{ "type": "hello-ok", "nonce": <same-uuid>, "protocolVersion": 1 }`.
  Constants at `runtime_supervisor.rs:15` (`PROTOCOL_VERSION = 1`)
  and `src/desktop-runtime/protocol/frames.ts:62`
  (`DESKTOP_RUNTIME_PROTOCOL_VERSION`).
- Carrier: length-prefixed JSON frames. Reuse the existing readers/
  writers from `src/desktop-runtime/protocol/stdioCarrier.ts`.

**Test shape (concrete):**

```ts
const sidecar = await spawnSidecar({ tmpConfigDir });   // builds + spawns + handshakes
const id = randomUUID();
await sidecar.sendControl({ type: 'control-request', id, method: 'config.get',
                            params: { key: 'someExistingKey' } });
const res = await sidecar.awaitControlResponse(id);
expect(res.ok).toBe(true);                              // protocol round-trip works
await sidecar.shutdown();                               // graceful within SHUTDOWN_GRACE
```

`spawnSidecar` and the response-await helper live in a small test
helper file. No `ParityBinding`, no harness, no scenarios.

**What we do with the broken scaffolding.** The existing tautological
`scenarios.test.ts` is deleted. The `scenarios.ts` library and
`SCENARIO_EVENT_SEQUENCES` stay in tree for now — a future "full
functional verification" track can rewrite them against a real
deterministic agent stack. We leave a header note in `scenarios.ts`
acknowledging the Op-shape and sessionId issues so the next reader
doesn't trip on them.

### Goal 2 — Rust supervisor lifecycle `tokio::test` suite

Add a `tokio::test` suite that exercises the supervisor's lifecycle
paths using a fake child binary, `tauri::test::mock_app()` for the
`AppHandle`, and `tokio::time::pause()` to keep backoff tests fast.

**Fake-child injection seam.** The supervisor already has two
test-friendly env vars:

- `APPLEPI_NODE_BIN=<path>` (`runtime_supervisor.rs:341-344`) — override
  the node binary the supervisor invokes.
- `APPLEPI_DESKTOP_RUNTIME_ENTRY=<path>` (`runtime_supervisor.rs:111`)
  — override the runtime entry path.

Strategy: point `APPLEPI_NODE_BIN` at our fake-child binary; the fake
ignores its first arg (the entry path) and uses its own env to decide
how to behave. This avoids needing a "test-only command builder"
refactor.

**AppHandle.** Tauri exposes `tauri::test::mock_builder()` /
`mock_app()` returning an `App<MockRuntime>` whose `AppHandle` supports
`emit`. If `supervise()` or `spawn_once()` reaches functionality that
mock-runtime doesn't cover, refactor at most the emit surface to take
a `Fn(event: &str, payload: Value)` callback — note this as an
explicit step in tasks.md rather than a surprise.

**Time control.** Wrap tests in `tokio::time::pause()` and use
`tokio::time::advance(...)` to skip past `RESTART_BASE_MS` /
`RESTART_MAX_MS` waits without real-time delay. The supervise loop's
`tokio::time::sleep` is pausable.

**Lifecycle paths to cover** (each test references supervisor
constants by name, never hardcoded numbers):

- `successful_handshake` — fake responds with valid `hello-ok`;
  assert `supervising = true` set within a deadline.
- `handshake_reject_nonce` — fake responds with wrong nonce; assert
  `supervising` stays false; child is reaped.
- `handshake_reject_version` — fake responds with wrong
  `protocolVersion`; same assertions.
- `pre_handshake_failure_backoff_and_cap` — fake always rejects
  handshake; with paused time, assert the supervise loop sleeps
  `RESTART_BASE_MS << min(attempt-1, 6)` clamped at `RESTART_MAX_MS`
  for each attempt, and gives up after `MAX_RESTART_ATTEMPTS`,
  emitting `runtime:failed`. This is the scenario where the cap
  actually triggers because there's no valid handshake to reset
  `attempt` to zero (`runtime_supervisor.rs:573`).
- `post_handshake_crash_resets_attempt` — fake handshakes cleanly, then
  exits after N frames; with paused time, assert `attempt` resets to
  0 on each successful handshake, so the supervisor keeps respawning
  indefinitely (no `MAX_RESTART_ATTEMPTS` hit). Documents the current
  semantics; pair with a comment explaining the design.
- `graceful_shutdown_within_grace` — fake handshakes; send `shutdown`;
  assert child exits within `SHUTDOWN_GRACE`.
- `forced_kill_after_grace` — fake ignores `shutdown`; assert SIGKILL
  fires after `SHUTDOWN_GRACE`.
- `orphan_cleanup` — drop supervisor without sending `shutdown`;
  assert child is no longer running.
- `stderr_does_not_block_stdout` — fake emits large stderr alongside a
  valid handshake; assert handshake completes within a deadline that
  excludes stderr-drain time.

### Goal 3 — Real `diagnostics.recentStderr` ring buffer

Replace the stub at `runtime_supervisor.rs:298-305` with a bounded
line-oriented ring buffer fed by the existing stderr drain task at
lines 452-465.

**Concrete policy** (locked in to avoid bikeshedding at PR time):

- **Storage.** Line-oriented. The stderr task today reads 4096-byte
  chunks; split on `\n` and push each line. Carry over the trailing
  partial line into the next read.
- **Caps.** `LINE_CAP = 200` lines, `BYTE_CAP = 64 KiB`. Eviction is
  FIFO when either cap is exceeded.
- **Retention across child restarts.** **Keep** the buffer across
  child (re)spawn within one supervisor lifetime. This is when stderr
  is most diagnostic ("why did the runtime restart 3 times?");
  resetting on each spawn would erase the evidence.
- **Storage location.** Add a `recent_stderr: VecDeque<RingLine>`
  field to the existing `RuntimeSupervisor` struct
  (`runtime_supervisor.rs:33-44`), under the same `Arc<Mutex<...>>`.
  Each `RingLine` carries `{ generation: u64, ts_ms: i64, line: String }`
  so callers can correlate lines with child restarts.
- **Control-frame response.** The `"diagnostics.recentStderr"` handler
  returns `{ "lines": [{ "generation": …, "ts_ms": …, "line": "…" }, …] }`
  in insertion order. Wire shape is additive vs the current
  `{ "lines": [] }` — callers that ignore unknown fields don't break.

## Approach

Order (smallest → largest):

1. Goal 3 — single Rust file, no test infrastructure changes. Lowest
   risk.
2. Goal 2 — needs the fake-child binary + `mock_app()` integration +
   paused-time wiring. Largest Rust-side work, but isolated.
3. Goal 1 — touches CI matrix and node-side test setup. Smallest
   surface change once the infrastructure decisions above are settled.

## Dependencies

- Track 43 _DONE — provides the runtime, supervisor, sidecar build
  script, and the env-seam env vars (`APPLEPI_NODE_BIN`,
  `APPLEPI_DESKTOP_RUNTIME_ENTRY`,
  `APPLEPI_DESKTOP_RUNTIME_ALLOW_DEV_HOST`).

## Exit criteria

- **Goal 1.** `npm run test src/desktop-runtime/parity/__tests__/spawnedSidecar.smoke.integration.test.ts`
  green in CI for Linux. The test spawns a real sidecar, completes the
  handshake, performs at least one successful control-frame
  round-trip, and shuts down cleanly within `SHUTDOWN_GRACE`. The
  tautological `scenarios.test.ts` is deleted.
- **Goal 2.** `cargo test --manifest-path tauri/Cargo.toml supervisor::lifecycle`
  green. Each lifecycle path listed in goal 2 has a dedicated
  `#[tokio::test]`. Backoff assertions use paused time and reference
  supervisor constants. Both the pre-handshake-cap test and the
  post-handshake-reset test are present.
- **Goal 3.** The `diagnostics.recentStderr` handler returns at least
  one entry after stderr has been written; the buffer is bounded by
  both `LINE_CAP` and `BYTE_CAP`; entries carry `generation` and
  `ts_ms`; the existing `runtime:stderr` Tauri event continues to
  fire (no UI regression).

When all three are met, Track 45 closes. Track 43's remaining items at
that point are: (a) the release-engineer multi-OS hand-offs already
documented in Track 43 Phase 4, and (b) the deferred "full functional
turn verification with deterministic agent fixtures" — a separate
future track, not Track 45's responsibility.
