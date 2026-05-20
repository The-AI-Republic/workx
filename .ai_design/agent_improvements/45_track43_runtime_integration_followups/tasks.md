# Track 45 Tasks

**Status (2026-05-20, revised after implementation-readiness audit): OPEN.**

Closes three verification gaps from Track 43:
1. Spawned-sidecar protocol & lifecycle smoke test (real sidecar
   process, real handshake, real control round-trip, real shutdown)
2. Rust supervisor lifecycle `tokio::test` suite (paused time + fake
   child)
3. Real `diagnostics.recentStderr` ring buffer (replaces stub)

Out of scope by intention (see `design.md` non-goals + the "what this
track does NOT attempt" section): rewriting the Track 43 parity
scaffolding (`scenarios.ts` + `SCENARIO_EVENT_SEQUENCES`) into real
fixtures, full functional turn verification, frame-schema
consolidation, direct Rust→runtime deeplink push frame, per-feature
bootstrap parity assertion vs deleted code, relay round-trip test,
crash/restart soak in CI, and any multi-OS / release-time items still
owned by Track 43 Phase 4.

See [`design.md`](./design.md) for context, the explicit deferral list,
launch shape, ring-buffer policy, and exit criteria.

---

## Goal 1: Spawned-sidecar protocol & lifecycle smoke test

Spawns the real Apple Pi desktop runtime sidecar, completes the
handshake, performs a side-effect-free control round-trip, and shuts
down cleanly. Does **not** drive UserInput ops, does **not** compare
against `SCENARIO_EVENT_SEQUENCES`.

**Prerequisites:**
- `npm run build:desktop-runtime-sidecar` must run before this test
  (already in `tauri.conf.json:8` beforeBuild; the integration test
  needs to invoke it standalone or assert the output exists).
- Node 20.19+ / 22+ available in the CI image (matches
  `runtime_supervisor.rs:423` and the sidecar's own runtime
  requirement).

### Tasks

- [ ] Add `src/desktop-runtime/parity/__tests__/spawnedSidecar.helper.ts`
      exporting `spawnSidecar(opts: { tmpConfigDir: string }): Promise<SpawnedSidecar>`.
      Implementation:
  - Resolve sidecar entry: `tauri/sidecar/desktop-runtime/index.mjs`
    relative to repo root. Fail clearly if missing — instruct user to
    run `npm run build:desktop-runtime-sidecar`.
  - Spawn `node <index.mjs>` via `node:child_process.spawn` with env:
    - `APPLEPI_RUNTIME_PROFILE=desktop-runtime`
    - `APPLEPI_DESKTOP_RUNTIME_ALLOW_DEV_HOST=true`
    - `APPLEPI_DESKTOP_CONFIG_DIR=<opts.tmpConfigDir>` so
      `createDevDesktopRuntimeHost` (`src/desktop-runtime/host.ts:46-90`)
      builds the host pointing at a clean throwaway location.
  - Capture stdin + stdout streams; drain stderr to the test logger
    for diagnostics.
  - Drive the handshake: write a length-prefixed
    `{ "type": "hello", "nonce": randomUUID(), "protocolVersion": 1 }`
    frame; await matching `hello-ok` on stdout. Reuse the frame
    writer/reader from `src/desktop-runtime/protocol/stdioCarrier.ts`.
    Time out the wait at 30s.
  - Return `SpawnedSidecar` exposing:
    - `sendControl(frame: ControlRequestFrame): Promise<void>`
    - `awaitControlResponse(id: string, timeoutMs?: number): Promise<ControlResponseFrame>`
    - `shutdown(): Promise<void>` — send `shutdown` frame, wait up to
      `SHUTDOWN_GRACE` (5s), then SIGKILL.
- [ ] Add `src/desktop-runtime/parity/__tests__/spawnedSidecar.smoke.integration.test.ts`
      following the repo's `*.integration.test.ts` convention (see
      `src/core/__tests__/TurnManager.parallelTools.integration.test.ts`):
  - `beforeAll` creates a tmp config dir via `node:os.tmpdir()` +
    `node:fs.mkdtempSync`, calls `spawnSidecar`.
  - `afterAll` calls `sidecar.shutdown()` and removes the tmp dir.
  - Test 1: handshake completes (covered by `spawnSidecar` resolving).
  - Test 2: control round-trip. Send a `control-request` for a
    side-effect-free method (e.g. `config.get` with an existing key,
    or a minimal `runtime.getStateSnapshot` if `config.get` requires
    a key the test can't predict). Assert the matching
    `control-response` arrives with `ok: true` within 5s.
  - Test 3: graceful shutdown. Send the `shutdown` frame; assert the
    child process exits within `SHUTDOWN_GRACE`. (This is implicitly
    covered by `afterAll`; promote to its own explicit test so the
    timing assertion is part of the named-test output.)
- [ ] Pick the smoke-test control method by reading
      `src/desktop-runtime/controlFrameHandlers.ts` (or wherever the
      runtime's control-frame router lives). Prefer one that needs no
      pre-seeding to succeed. Document the choice in the test's
      docstring.
- [ ] Delete the existing tautological
      `src/desktop-runtime/parity/__tests__/scenarios.test.ts`.
- [ ] Add a header note to `src/desktop-runtime/parity/scenarios.ts`
      acknowledging that the scenario Op payloads
      (`{ type: 'UserInput', items: [{ type: 'Text', text }] }` —
      uppercase `'Text'`, envelope-shape, missing sessionId) and the
      synthetic `SCENARIO_EVENT_SEQUENCES` are placeholders that will
      need to be rewritten before they can be used against a real
      runtime. Mark the file `@deprecated for use against real
      runtimes; see Track 45 design`.
- [ ] Wire the new integration test into the CI workflow for Linux
      (gate on `os: ubuntu-*`). macOS and Windows runs remain
      release-time per Track 43 Phase 4.
- [ ] Re-annotate `43_apple_pi_runtime_decoupling_DONE/tasks.md:86`
      with the narrower truth: "transport-level smoke landed via
      Track 45; full `PARITY_SCENARIOS`-vs-real-runtime test still
      deferred pending deterministic agent-stack fixtures". Do NOT
      tick the box. Do NOT touch line 115.

---

## Goal 2: Rust supervisor lifecycle `tokio::test` suite

Adds directed tests for the lifecycle paths in
`tauri/src/runtime_supervisor.rs` using a fake child binary, mock
`AppHandle`, and paused tokio time.

### Tasks

- [ ] Create `tauri/tests/bin/fake-runtime-child.rs` declared as a
      separate Cargo bin in `tauri/Cargo.toml`:
      `[[bin]] name = "fake-runtime-child"
       path  = "tests/bin/fake-runtime-child.rs"`.
      The binary ignores its first arg (the entry path the supervisor
      passes after the node binary) and reads behavior from env:
  - `FAKE_HANDSHAKE = "ok" | "reject-nonce" | "reject-version" | "silent"`
  - `FAKE_EXIT_AFTER = <N>` — exit cleanly after N response frames
  - `FAKE_IGNORE_SHUTDOWN = "1"` — accept shutdown frame but never exit
  - `FAKE_STDERR_LINES = <N>` — emit N stderr lines on startup, then proceed
- [ ] Wire the fake child into supervisor tests via
      `APPLEPI_NODE_BIN=env!("CARGO_BIN_EXE_fake-runtime-child")`. This
      uses the existing override seam at
      `runtime_supervisor.rs:341-344`; no production code change
      needed.
- [ ] Decide whether `supervise()` / `spawn_once()` can be exercised
      against `tauri::test::mock_app()` as-is. If `app.emit(...)` works
      cleanly on the mock runtime, use it directly. If not (e.g.,
      because `mock_runtime` doesn't compose with the existing event
      emit), do a minimal refactor: extract the emit calls behind a
      `Fn(&str, Value) -> ()` callback parameter on `supervise`. Add
      that refactor as a checked task here rather than discovering it
      mid-PR.
  - [ ] Audit `supervise()` and `spawn_once()` event emissions
        (`runtime:reconnecting`, `runtime:failed`, `runtime:down`,
        `runtime:error`, `runtime:stderr`, `runtime:ready`).
  - [ ] If a refactor is required, land it as a separate prep commit
        and confirm production behavior is unchanged.
- [ ] Add `tauri/src/runtime_supervisor/lifecycle_tests.rs` (or
      `#[cfg(test)] mod lifecycle_tests` inline in
      `runtime_supervisor.rs`). All tests resolve the fake child via
      `env!("CARGO_BIN_EXE_fake-runtime-child")` and use
      `tokio::time::pause()` + `tokio::time::advance(...)` for
      backoff-sensitive cases:
  - [ ] `successful_handshake` — `FAKE_HANDSHAKE=ok`; assert
        `supervising` becomes true within a deadline.
  - [ ] `handshake_reject_nonce` — `FAKE_HANDSHAKE=reject-nonce`;
        assert supervisor never marks `supervising=true` and child is
        reaped.
  - [ ] `handshake_reject_version` — `FAKE_HANDSHAKE=reject-version`;
        same assertion as above.
  - [ ] `pre_handshake_failure_backoff_and_cap` — `FAKE_HANDSHAKE=silent`
        (never sends `hello-ok`), `spawn_once` returns `Ok(false)`
        each attempt. With paused time, advance through each backoff
        interval and assert: (a) backoff at attempt N is
        `RESTART_BASE_MS << min(N-1, 6)` clamped at `RESTART_MAX_MS`;
        (b) `runtime:reconnecting` emitted with correct `delayMs`
        each attempt; (c) supervisor emits `runtime:failed` after
        `MAX_RESTART_ATTEMPTS` and exits the loop. This is the
        scenario where the cap actually triggers because no valid
        handshake ever resets `attempt = 0`
        (`runtime_supervisor.rs:573`).
  - [ ] `post_handshake_crash_resets_attempt` — `FAKE_HANDSHAKE=ok,
        FAKE_EXIT_AFTER=0` (handshakes, then exits). Assert
        supervisor respawns indefinitely (no `runtime:failed`),
        documenting the current "any successful handshake resets
        attempt to 0" semantics. Pair with a comment in the test
        explaining the design choice.
  - [ ] `graceful_shutdown_within_grace` — `FAKE_HANDSHAKE=ok`; send
        `shutdown`; assert child exits within `SHUTDOWN_GRACE`.
  - [ ] `forced_kill_after_grace` — `FAKE_IGNORE_SHUTDOWN=1`; with
        paused time, advance past `SHUTDOWN_GRACE`; assert SIGKILL
        fires.
  - [ ] `orphan_cleanup` — drop the `RuntimeSupervisorState` without
        sending shutdown; assert the child is no longer running.
  - [ ] `stderr_does_not_block_stdout` — `FAKE_STDERR_LINES=10000,
        FAKE_HANDSHAKE=ok`; assert handshake completes within a
        deadline that excludes stderr-drain time.
- [ ] All tests reference supervisor constants by name (`RESTART_BASE_MS`,
      `RESTART_MAX_MS`, `MAX_RESTART_ATTEMPTS`, `SHUTDOWN_GRACE`)
      rather than hardcoded numbers, so future tuning doesn't desync
      the tests.
- [ ] Update `43.../tasks.md:113` to tick the Phase 2 supervisor-tests
      box and drop the `[not-yet-real]` annotation; cross-link to
      Track 45 in the note.

---

## Goal 3: Real `diagnostics.recentStderr` ring buffer

Replaces the stub at `tauri/src/runtime_supervisor.rs:298-305`. Policy
is fixed in `design.md` so this is a straight implementation task.

### Tasks

- [ ] Add `const LINE_CAP: usize = 200;` and `const BYTE_CAP: usize = 64 * 1024;`
      near the existing `RESTART_BASE_MS` / `SHUTDOWN_GRACE` block
      (`runtime_supervisor.rs:19-23`).
- [ ] Add a `RingLine` struct (`generation: u64`, `ts_ms: i64`,
      `line: String`, with `#[derive(Clone, Serialize)]`) and a
      `recent_stderr: VecDeque<RingLine>` field on the existing
      `RuntimeSupervisor` struct (lines 33-44). Default to empty.
- [ ] Modify the stderr drain task (lines 452-465):
  - Maintain a partial-line buffer across `read()` calls (split chunks
    on `\n`, carry trailing partial line into next iteration).
  - For each completed line: acquire the supervisor lock, push a
    `RingLine { generation, ts_ms: now_ms(), line }`, then evict from
    the front until `len() <= LINE_CAP` and total byte length of all
    `line` fields `<= BYTE_CAP`.
  - Continue emitting the existing `runtime:stderr` Tauri event so
    UI behavior does not regress.
- [ ] Replace the stub at lines 298-305 with:
  ```rust
  let guard = state.inner.lock().await;
  let lines: Vec<_> = guard.recent_stderr.iter().cloned().collect();
  Ok(json!({ "lines": lines }))
  ```
  Drop the "real implementation would back this with a ring buffer"
  comment.
- [ ] Add a `#[tokio::test]` under the Goal 2 lifecycle module:
      `FAKE_STDERR_LINES=300, FAKE_HANDSHAKE=ok`; await handshake;
      invoke the `diagnostics.recentStderr` control-frame handler
      directly (without going through the network); assert exactly
      `LINE_CAP` entries (oldest evicted), entries are in insertion
      order, each carries `generation` + `ts_ms`.
- [ ] Update `43.../tasks.md:109` to tick the diagnostics-bridge box
      and drop the `[stub]` annotation; cross-link to Track 45.

---

## Exit

All boxes above checked. At that point Track 43's only remaining items
are: (a) release-engineer multi-OS hand-offs already documented in
Track 43 Phase 4, and (b) the deferred "full functional turn
verification with deterministic agent fixtures" — a separate future
track, not Track 45's responsibility.
