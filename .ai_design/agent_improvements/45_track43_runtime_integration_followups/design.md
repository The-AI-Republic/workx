# Track 45 — Apple Pi Runtime: real-sidecar integration + verification gaps (follow-up to Track 43)

Date: 2026-05-20
Status: OPEN — P1
Follows up: [Track 43 — Apple Pi Runtime Decoupling](../43_apple_pi_runtime_decoupling_DONE/design.md) (shipped PRs #246 + #255)

> Follow-up track. Track 43's design doc is **not** modified. This captures
> the three verification gaps that remained after the Track 43 cutover
> landed — items where shipped behavior depends on code we have not yet
> exercised in CI. Lower-priority items from Track 43's annotations
> (frame-schema consolidation, per-feature bootstrap parity assertion,
> direct Rust→runtime deeplink push frame, relay round-trip test,
> crash/restart soak) are intentionally **not** in scope here — they are
> opportunistic refactors or additive tests on top of goal 1 and can be
> picked up as PR-sized improvements without their own track.

## Why this track exists

After PR #255 the desktop **runs** on the runtime sidecar end-to-end: the
cuttable surface (storage providers, MCP/Node ports, UI cutover, OAuth,
control bridges, packaging script self-test) is shipped and the
unit/contract test suite is green.

What is **not** proven by today's CI:

1. **Desktop sidecar correctness is unverified in CI.** The existing
   `src/desktop-runtime/parity/__tests__/scenarios.test.ts` registers
   two fake bindings that both drain from the same
   `SCENARIO_EVENT_SEQUENCES` lookup, so the positive-path comparison
   is `JSON.stringify(X) === JSON.stringify(X)`. The file's own header
   docstring (lines 1-30) calls this out. Nothing in CI actually
   spawns the real Apple Pi desktop sidecar and asserts it produces
   the event sequences `PARITY_SCENARIOS` expects. See
   `43.../tasks.md:86`. (The original Track 43 design also envisioned
   a *separate* future test that runs both server and desktop
   transports through the same scenarios for transport-parity — see
   `43.../tasks.md:115`. That is **not** what this track is about; it
   stays deferred. Track 45 is just about verifying the desktop side
   on its own.)
2. **Rust supervisor lifecycle untested.** `tauri/src/runtime_supervisor.rs`
   handles spawn, handshake, restart with bounded backoff
   (`RESTART_BASE_MS = 500ms`, `RESTART_MAX_MS = 30s`,
   `MAX_RESTART_ATTEMPTS = 10`), graceful shutdown (`SHUTDOWN_GRACE = 5s`),
   forced kill, orphan cleanup, and stderr drain. None of these paths
   has a directed `cargo test`; only helper-level coverage exists
   (`required_str`, frame parsing). The supervisor is the long-running
   OS-level component; lifecycle bugs are real production risk.
   See `43.../tasks.md:113`.
3. **`diagnostics.recentStderr` is a stub.**
   `tauri/src/runtime_supervisor.rs:298-305` matches the control method
   and returns `{ "lines": [] }` so callers don't break. The supervisor
   already drains stderr via a separate task that emits `runtime:stderr`
   Tauri events (lines 452-465), but no buffer exists for the runtime
   to read its own recent stderr back via the control frame.
   See `43.../tasks.md:109`.

The release-engineer hand-offs (three-OS `tauri:build` smoke, multi-OS
keychain read-through, resource footprint, startup latency, updater
verification) remain **out of scope** — they are not code work and
continue to be owned by release at tag time per Track 43 Phase 4.

## Goals

### Goal 1 — Spawned-sidecar correctness test

Build a CI integration test that spawns the **real** desktop runtime
sidecar (the Apple Pi runtime) and asserts each `PARITY_SCENARIOS`
entry produces its canonical event sequence
(`SCENARIO_EVENT_SEQUENCES[<name>]`).

This is a **correctness** test for the desktop sidecar, not a parity
test. It does not use `runParityHarness`. The harness was designed to
compare two real transports (server WebSocket vs desktop stdio) for an
eventual server-vs-desktop parity exit gate — that test remains
deferred (still useful future work; not blocking Apple Pi desktop
readiness, which is what this track is about). The harness and
`scenarios.ts` library stay in the codebase intact so the deferred
parity test has nothing to wire up when someone picks it up.

**Launch shape** (matches what `runtime_supervisor.rs` does today):

- Sidecar entry: `tauri/sidecar/desktop-runtime/index.mjs` — built by
  `npm run build:desktop-runtime-sidecar`. Not a self-contained
  executable; runs under Node.
- Spawn: `node <path-to-index.mjs>` with env
  `APPLEPI_RUNTIME_PROFILE=desktop-runtime`.
- Handshake (caller side):
  send `{ "type": "hello", "nonce": <uuid>, "protocolVersion": 1 }`,
  wait for `{ "type": "hello-ok", "nonce": <same-uuid>, "protocolVersion": 1 }`.
  Constants live at `runtime_supervisor.rs:15` (`PROTOCOL_VERSION = 1`)
  and `src/desktop-runtime/protocol/frames.ts`
  (`DESKTOP_RUNTIME_PROTOCOL_VERSION`).
- Carrier: length-prefixed JSON frames over the child's stdin/stdout
  (reuse readers/writers from
  `src/desktop-runtime/protocol/stdioCarrier.ts`).

**Test shape (direct assertion, no harness):**

```ts
for (const scenario of PARITY_SCENARIOS) {
  for (const step of scenario.steps) {
    await sidecar.submit(step.op, step.context);
  }
  const events = await sidecar.drainEvents();
  expect(normalize(events))
    .toEqual(normalize(SCENARIO_EVENT_SEQUENCES[scenario.name]));
}
```

where `sidecar` is a small helper that wraps the spawned child process:
`submit()` writes a `request` frame, `drainEvents()` returns events
received since the last drain. The `normalize()` function is the same
default normalizer the harness uses
(`{ msg, sessionId }` projection — see `ParityHarness.ts:41`) so we
benefit from the existing equivalence definition without invoking the
harness itself.

**What about the existing `scenarios.test.ts` tautology?** It can be
deleted outright once the new test is green — its only purpose was to
hold the place for a real test. (Optionally keep a slimmed file that
asserts only "every `PARITY_SCENARIOS` name appears as a key in
`SCENARIO_EVENT_SEQUENCES`" as a defensive contract on the
scenarios library; that's a 5-line shape check, not parity proof.)

### Goal 2 — Rust supervisor lifecycle tests

Add a `tokio::test` suite that spawns a **fake child** binary and
exercises every documented lifecycle path. The fake child lives as a
separate Cargo `[[bin]]` target so the tests can pass its path via env
var rather than depending on the real runtime bundle.

Lifecycle paths to cover (each backed by a `RuntimeSupervisor`
constant — tests should reference the constants, not hardcode):

- Successful spawn + `hello`/`hello-ok` handshake.
- Handshake reject — wrong nonce.
- Handshake reject — wrong `protocolVersion`.
- Restart with bounded backoff on unexpected exit (assert backoff
  respects `RESTART_BASE_MS` / `RESTART_MAX_MS` / `MAX_RESTART_ATTEMPTS`).
- Graceful quit on `shutdown` frame (assert within `SHUTDOWN_GRACE`).
- Forced kill after `SHUTDOWN_GRACE` expires (child ignores `shutdown`).
- Orphan cleanup when the parent exits without a `shutdown` frame.
- stderr drain captures output without blocking stdout protocol frames.

### Goal 3 — Real `diagnostics.recentStderr` ring buffer

Replace the stub at `runtime_supervisor.rs:298-305` with a bounded
line-oriented ring buffer fed by the existing stderr drain task at
lines 452-465.

**Concrete policy** (locks in to avoid bikeshedding at PR time):

- **Storage.** Line-oriented. The stderr task today reads 4096-byte
  chunks; split on `\n` and push each line. Carry over the trailing
  partial line into the next read.
- **Caps.** `LINE_CAP = 200` lines, `BYTE_CAP = 64 KiB`. Eviction is
  FIFO when either cap is exceeded.
- **Retention across child restarts.** **Keep** the buffer across
  child (re)spawn within one supervisor lifetime. This is when stderr
  is most diagnostic ("why did the runtime restart 3 times?"); resetting
  on each spawn would erase the evidence. Caller can use the buffer's
  natural FIFO eviction to bound size.
- **Storage location.** Add a `recent_stderr: VecDeque<RingLine>` field
  to the existing `RuntimeSupervisor` struct
  (`runtime_supervisor.rs:33-44`), under the same `Arc<Mutex<...>>`.
  Each `RingLine` carries `{ generation: u64, ts_ms: i64, line: String }`
  so callers can correlate lines with child restarts and recent activity.
- **Control-frame response.** The
  `"diagnostics.recentStderr"` handler returns
  `{ "lines": [{ "generation": …, "ts_ms": …, "line": "…" }, …] }`
  in insertion order. The wire shape is additive vs the current
  `{ "lines": [] }` — callers that ignore unknown fields don't break.

## Approach

Goals 1, 2, 3 are independent and can land in any order / parallel PRs.
Suggested ordering (smallest → largest):

1. Goal 3 — single Rust file, no infrastructure. Lowest risk.
2. Goal 2 — needs a new Cargo `[[bin]]` target and a `tokio::test`
   harness, but lives entirely under `tauri/`.
3. Goal 1 — touches CI matrix, Node bundling, vitest integration setup.
   Largest blast radius; do it last so the test of the test stack is
   already in place.

## Dependencies

- Track 43 _DONE — provides the runtime, supervisor, relay transport,
  parity harness mechanism, scenario list, and the sidecar build script
  that goal 1 calls.

## Exit criteria

- **Goal 1.** `npm run test src/desktop-runtime/parity/__tests__/spawnedSidecar.scenarios.integration.test.ts`
  green in CI for Linux. Every `PARITY_SCENARIOS` entry matches its
  `SCENARIO_EVENT_SEQUENCES` reference when run through a freshly
  spawned sidecar (Apple Pi desktop runtime, profile
  `desktop-runtime`). The existing tautological `scenarios.test.ts`
  is deleted, or replaced with a 5-line shape check that every
  scenario name has a canonical-sequence key.
- **Goal 2.** `cargo test --manifest-path tauri/Cargo.toml supervisor::lifecycle`
  green. Each lifecycle path listed in goal 2 has a dedicated
  `#[tokio::test]`. Backoff/grace assertions reference the supervisor
  constants by name.
- **Goal 3.** The control-frame handler returns at least one entry
  after stderr has been written; the buffer is bounded by both
  `LINE_CAP` and `BYTE_CAP`; entries carry `generation` and `ts_ms`;
  the existing `runtime:stderr` Tauri event continues to fire (no
  regression of UI-side stderr display).

When all three are met, Track 45 closes. Track 43's remaining items
at that point are exclusively the release-engineer multi-OS hand-offs
already documented in Track 43 Phase 4.
