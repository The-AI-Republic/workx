# Track 45 Tasks

**Status (2026-05-20): OPEN — follow-up to Track 43, trimmed to essentials.**

Closes the three highest-value verification gaps from Track 43:
1. Real spawned-sidecar parity test (replaces tautological CI)
2. Rust supervisor lifecycle `tokio::test` suite
3. Real `diagnostics.recentStderr` ring buffer (replaces stub)

Out of scope by intention (see `design.md` non-goals): frame-schema
consolidation, direct Rust→runtime deeplink push frame, per-feature
bootstrap parity assertion vs deleted code, relay round-trip test,
crash/restart soak in CI, and any multi-OS / release-time items still
owned by Track 43 Phase 4.

See [`design.md`](./design.md) for context, launch shape, ring-buffer
policy, and exit criteria.

---

## Goal 1: Spawned-sidecar parity test

Replaces `src/desktop-runtime/parity/__tests__/scenarios.test.ts` (the
tautological lookup-vs-lookup test) with a real integration test that
spawns the sidecar and asserts it produces the canonical event sequences.

**Prerequisites:**
- `npm run build:desktop-runtime-sidecar` must run as a CI step before
  this test (it already runs from `tauri.conf.json:8` beforeBuild, but
  the integration test needs to invoke it standalone if not already
  invoked).
- Node 20.19+ / 22+ available in the CI image (same requirement as the
  sidecar itself — see `runtime_supervisor.rs:423`).

### Tasks

- [ ] Add `src/desktop-runtime/parity/__tests__/spawnedSidecar.harness.ts`
      exporting `createSpawnedSidecarBinding(): Promise<ParityBinding>`.
      Implementation:
  - Resolve sidecar entry: `tauri/sidecar/desktop-runtime/index.mjs`
    relative to repo root. Fail clearly if missing — instruct user to
    run `npm run build:desktop-runtime-sidecar`.
  - Spawn `node <index.mjs>` with `env.APPLEPI_RUNTIME_PROFILE =
    'desktop-runtime'` (use `node:child_process.spawn`, capture stdin
    + stdout streams, drain stderr to test console for diagnostics).
  - Drive the handshake: write a length-prefixed
    `{ "type": "hello", "nonce": randomUUID(), "protocolVersion": 1 }`
    frame to stdin; wait for matching `hello-ok` on stdout. Reuse the
    frame writer/reader from `src/desktop-runtime/protocol/stdioCarrier.ts`.
  - Return a `ParityBinding` whose `submit()` writes a `request` frame
    wrapping the `Op`, `drainEvents()` returns events accumulated since
    the last drain, and `shutdown()` sends a `shutdown` frame, waits up
    to `SHUTDOWN_GRACE` (5s), then SIGKILLs.
- [ ] Add `src/desktop-runtime/parity/__tests__/spawnedSidecar.scenarios.integration.test.ts`
      following the repo's `*.integration.test.ts` convention (see
      `src/core/__tests__/TurnManager.parallelTools.integration.test.ts`):
  - Build a "canonical replay" `ParityBinding` whose `drainEvents()`
    returns `SCENARIO_EVENT_SEQUENCES[currentScenarioName]` verbatim.
  - For each scenario in `PARITY_SCENARIOS`, run
    `runParityHarness([sidecarBinding, canonicalReplayBinding],
    [scenario])` and assert `report.ok === true`.
  - One global `beforeAll` spawns the sidecar; `afterAll` shuts it down.
- [ ] Delete the existing tautological
      `src/desktop-runtime/parity/__tests__/scenarios.test.ts`
      OR replace its contents with mechanism-only smoke tests (harness
      ≥2-binding check, `SCENARIO_EVENT_SEQUENCES` keys match
      `PARITY_SCENARIOS` names). Update the file's docstring to drop
      the "follow-up integration test does not exist yet" paragraph.
- [ ] Wire the new integration test into the CI workflow for Linux
      (gate on `os: ubuntu-*`). macOS and Windows runs remain release-time
      per Track 43 Phase 4.
- [ ] Update `43_apple_pi_runtime_decoupling_DONE/tasks.md:86,115` to
      tick those boxes and drop the `[scaffolding]` / `[not-yet-real]`
      annotations; cross-link to Track 45 in the annotation note.

---

## Goal 2: Rust supervisor lifecycle `tokio::test` suite

Adds directed tests for the lifecycle paths in
`tauri/src/runtime_supervisor.rs` that currently have only helper-level
coverage.

### Tasks

- [ ] Create `tauri/tests/bin/fake-runtime-child.rs` — a stand-alone Rust
      program (declared as `[[bin]] name = "fake-runtime-child" path =
      "tests/bin/fake-runtime-child.rs"` in `tauri/Cargo.toml`).
      Configurable failure modes via env vars:
  - `FAKE_HANDSHAKE = "ok" | "reject-nonce" | "reject-version" | "silent"`
  - `FAKE_EXIT_AFTER = <N>` — exit cleanly after N response frames
  - `FAKE_IGNORE_SHUTDOWN = "1"` — accept the shutdown frame but never exit
  - `FAKE_STDERR_LINES = <N>` — emit N stderr lines on startup, then proceed
- [ ] Add `tauri/src/runtime_supervisor/lifecycle_tests.rs` (or inline as
      `#[cfg(test)] mod lifecycle_tests { … }` in `runtime_supervisor.rs`).
      Each test resolves the fake-child path via
      `env!("CARGO_BIN_EXE_fake-runtime-child")` and exercises one path:
  - [ ] `successful_handshake` — `FAKE_HANDSHAKE=ok`, assert `supervising`
        becomes true within a deadline.
  - [ ] `handshake_reject_nonce` — `FAKE_HANDSHAKE=reject-nonce`, assert
        supervisor never marks `supervising=true` and child is reaped.
  - [ ] `handshake_reject_version` — `FAKE_HANDSHAKE=reject-version`,
        same assertion as above.
  - [ ] `restart_backoff_bounds` — child exits on each spawn; assert
        the supervisor's restart timing respects `RESTART_BASE_MS` and
        caps at `RESTART_MAX_MS`, and that after `MAX_RESTART_ATTEMPTS`
        attempts no further spawn is attempted.
  - [ ] `graceful_shutdown_within_grace` — send `shutdown`; assert child
        exits within `SHUTDOWN_GRACE`.
  - [ ] `forced_kill_after_grace` — `FAKE_IGNORE_SHUTDOWN=1`; send
        `shutdown`; assert SIGKILL fires after `SHUTDOWN_GRACE`.
  - [ ] `orphan_cleanup` — drop the supervisor without sending
        `shutdown`; assert the child is no longer running.
  - [ ] `stderr_does_not_block_stdout` — `FAKE_STDERR_LINES=10000`,
        scenario where stderr is large; assert handshake still completes
        and stdout frames are read promptly.
- [ ] All tests reference supervisor constants by name (`RESTART_BASE_MS`,
      `RESTART_MAX_MS`, `MAX_RESTART_ATTEMPTS`, `SHUTDOWN_GRACE`) rather
      than hardcoded numbers, so future tuning doesn't desync the tests.
- [ ] Update `43.../tasks.md:113-115` to tick the corresponding Phase 2
      test boxes and drop the `[not-yet-real]` annotations; cross-link
      to Track 45.

---

## Goal 3: Real `diagnostics.recentStderr` ring buffer

Replaces the stub at `tauri/src/runtime_supervisor.rs:298-305`. Policy
is fixed in `design.md` so this is a straight implementation task.

### Tasks

- [ ] Add `LINE_CAP: usize = 200` and `BYTE_CAP: usize = 64 * 1024`
      constants near the existing
      `RESTART_BASE_MS` / `SHUTDOWN_GRACE` block in
      `runtime_supervisor.rs` (lines 19-23).
- [ ] Add a `RingLine` struct (`generation: u64`, `ts_ms: i64`,
      `line: String`) and a `recent_stderr: VecDeque<RingLine>` field
      on the existing `RuntimeSupervisor` struct (lines 33-44). Default
      to empty `VecDeque`.
- [ ] Modify the stderr drain task (lines 452-465) to:
  - Maintain a partial-line buffer across `read()` calls (split chunks
    on `\n`, carry trailing partial line into next iteration).
  - For each completed line: acquire the supervisor lock, push a
    `RingLine { generation, ts_ms: now_ms(), line }`, then evict from
    the front until both `len() <= LINE_CAP` and total byte length
    `<= BYTE_CAP`.
  - Continue emitting the existing `runtime:stderr` Tauri event so the
    UI behavior does not regress.
- [ ] Replace the stub at lines 298-305 with:
  ```rust
  let guard = state.inner.lock().await;
  let lines: Vec<_> = guard.recent_stderr.iter().cloned().collect();
  Ok(json!({ "lines": lines }))
  ```
  Drop the "real implementation would back this with a ring buffer"
  comment.
- [ ] Add a unit test under the Goal 2 lifecycle suite (depends on
      `fake-runtime-child` from Goal 2):
      `FAKE_STDERR_LINES=300`, wait for child startup, call the
      `diagnostics.recentStderr` handler, assert the response contains
      exactly `LINE_CAP` entries (oldest evicted), entries are in
      insertion order, and each carries `generation` + `ts_ms`.
- [ ] Update `43.../tasks.md:109` to tick the diagnostics-bridge box
      and drop the `[stub]` annotation; cross-link to Track 45.

---

## Exit

All boxes above checked. At that point Track 43's only remaining items
are the release-engineer multi-OS hand-offs already documented in
Track 43 Phase 4 — and both tracks can be considered closed for code
purposes.
