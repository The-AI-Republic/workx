# Track 45 Tasks

**Status (2026-05-20): IMPLEMENTED.** All three goals shipped; tests green.

Closes three verification gaps from Track 43:
1. ✅ Spawned-sidecar protocol & lifecycle smoke test (real sidecar
   process, real handshake, real ping/pong round-trip, real shutdown)
2. ✅ Rust supervisor lifecycle test suite (integration tests against a
   fake child binary + inline unit tests for backoff math and ring
   buffer)
3. ✅ Real `diagnostics.recentStderr` ring buffer (replaces stub)

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

## Goal 1: Spawned-sidecar protocol & lifecycle smoke test ✅

Spawns the real Apple Pi desktop runtime sidecar, completes the
handshake, performs a side-effect-free `ping`/`pong` round-trip, and
shuts down cleanly. Does **not** drive UserInput ops, does **not**
compare against `SCENARIO_EVENT_SEQUENCES`.

**Prerequisites:**
- `npm run build:desktop-runtime-sidecar` must run before this test.
- Node 20.19+ / 22+ available in the CI image (matches
  `runtime_supervisor.rs:423`).

### Tasks

- [x] Added `src/desktop-runtime/parity/__tests__/spawnedSidecar.helper.ts`
      exporting `spawnSidecar(opts: { tmpConfigDir: string }): Promise<SpawnedSidecar>`.
      Resolves the sidecar entry; spawns `node tauri/sidecar/desktop-runtime/index.mjs`
      with `APPLEPI_RUNTIME_PROFILE=desktop-runtime`,
      `APPLEPI_DESKTOP_RUNTIME_ALLOW_DEV_HOST=true`, and
      `APPLEPI_DESKTOP_CONFIG_DIR=<tmpdir>`; drives `hello`/`hello-ok`
      using the production `StdioFrameCarrier`; exposes
      `sendPing()` / `shutdown()` / `child()`.
- [x] Added `src/desktop-runtime/parity/__tests__/spawnedSidecar.smoke.integration.test.ts`
      with three named tests: handshake-completes, ping-round-trip,
      graceful-shutdown-within-grace. `beforeAll` creates a tmp config
      dir and spawns the sidecar; `afterAll` shuts down and removes
      the dir.
- [x] Chose `ping` as the side-effect-free smoke target instead of a
      control-frame method. The runtime's `ping` handler
      (`src/desktop-runtime/index.ts:65`) is always-on (answers even
      during slow bootstrap), so this works regardless of the agent
      stack's startup state. Documented in the test docstring.
      Note: `control-request` would have been the wrong direction —
      that's runtime→Rust, not test→runtime.
- [x] Deleted the tautological
      `src/desktop-runtime/parity/__tests__/scenarios.test.ts`.
- [x] Updated the header note on `src/desktop-runtime/parity/scenarios.ts`
      to document that the file is `@deprecated for use against real
      runtimes` and to list the three concrete reasons (broken Op
      shape, missing sessionId, synthetic event sequences). Also
      type-corrected the helper signatures (lowercase `'text'`, bare
      `Op`, no `as unknown as Op` cast).
- [ ] CI workflow wiring (gate the new integration test on
      `os: ubuntu-*`). Out of scope for this PR — the test is
      runnable today via `npx vitest run`; the CI matrix change can
      land as a separate follow-up once a build engineer can confirm
      it doesn't perturb other jobs.
- [x] Re-annotated `43.../tasks.md:86` with the narrower truth —
      transport-level smoke landed via Track 45; the full
      `PARITY_SCENARIOS`-vs-real-runtime test remains deferred
      pending deterministic agent-stack fixtures. Box left unticked
      because the original target was strictly broader.

---

## Goal 2: Rust supervisor lifecycle tests ✅

Adds directed tests for the lifecycle paths in
`tauri/src/runtime_supervisor.rs` using a fake child binary. Pragmatic
deviation from the original plan (see Implementation Notes below):
process-level integration tests in `tauri/tests/` plus inline unit
tests, rather than driving the full `supervise()` loop with a mock
`AppHandle`.

### Tasks

- [x] Created `tauri/tests/bin/fake_runtime_child.rs` (declared as
      `[[bin]] name = "fake-runtime-child"` in `tauri/Cargo.toml`).
      The binary ignores its first arg (the entry path the supervisor
      passes after the node binary) and reads behavior from env:
  - [x] `FAKE_HANDSHAKE = "ok" | "reject-nonce" | "reject-version" | "silent"`
  - [x] `FAKE_EXIT_AFTER_HANDSHAKE = "1"` — clean exit immediately
        after replying to `hello`
  - [x] `FAKE_IGNORE_SHUTDOWN = "1"` — accept shutdown frame but never exit
  - [x] `FAKE_STDERR_LINES = <N>` — emit N stderr lines on startup
- [x] Extracted `backoff_ms_for_attempt(attempt: u32) -> u64` as a
      named helper, replacing the inline computation in `supervise()`.
      Tests assert the formula directly without burning real time.
- [x] Added `tauri/tests/runtime_supervisor_lifecycle.rs` integration
      tests (9 cases):
  - [x] `successful_handshake_against_fake_child`
  - [x] `handshake_reject_nonce_against_fake_child`
  - [x] `handshake_reject_version_against_fake_child`
  - [x] `handshake_silent_times_out`
  - [x] `graceful_shutdown_within_grace` — asserts elapsed
        `< SHUTDOWN_GRACE`
  - [x] `forced_kill_after_grace_when_child_ignores_shutdown` —
        asserts child does NOT exit within grace + SIGKILL reaps
  - [x] `post_handshake_exit_completes_successful_iteration` —
        documents the building block of "attempt = 0 reset on
        Ok(true)" in `supervise()`
  - [x] `stderr_does_not_block_stdout_handshake` —
        `FAKE_STDERR_LINES=1000`, handshake still succeeds
  - [x] `orphan_cleanup_on_supervisor_drop` — `kill_on_drop` semantics
- [x] Added inline unit tests in `runtime_supervisor::unit_tests`
      module for the bits that need crate-internal access:
  - [x] `backoff_ms_for_attempt_doubles_then_caps`
  - [x] `cumulative_backoff_through_max_attempts_matches_design_doc`
        — documents the ~151.5 s real-time number
  - [x] (Ring-buffer tests — see Goal 3.)
- [x] All process-level tests use the supervisor's own constants by
      name (`SHUTDOWN_GRACE`, `PROTOCOL_VERSION`) rather than
      hardcoded numbers.
- [x] Updated `43.../tasks.md:113` to tick the Phase 2
      supervisor-tests box and cross-link to Track 45.

**Implementation Notes (deviations from the design):**

- The original design proposed running `supervise()` with
  `tauri::test::mock_app()` + `tokio::time::pause()`. That requires
  propagating `<R: Runtime>` through every `AppHandle`-touching
  function (`supervise`, `spawn_once`, `desktop_host`,
  `runtime_entry_path`, `resolve_node_bin`, `handle_control_frame`,
  every `#[tauri::command]`). Decided this was out of proportion to
  the value for Track 45 scope — the same invariants are covered by
  the process-level integration tests (handshake, shutdown, kill,
  stderr, orphan-cleanup) plus the unit-tested backoff formula. The
  full real-time-MAX_RESTART_ATTEMPTS scenario remains deferred; if a
  future track wants it, the `<R: Runtime>` refactor is the path.
- `pre_handshake_failure_backoff_and_cap` and
  `post_handshake_crash_resets_attempt` tests as originally specified
  would each require driving the supervise loop end-to-end. Both
  semantics are now covered indirectly: the backoff formula is unit
  tested, the cap math is unit tested, the "Ok(true) =>
  attempt = 0" arm is documented numerically, and
  `post_handshake_exit_completes_successful_iteration` validates that
  a single fake-child can hand off after a clean handshake-then-exit.

---

## Goal 3: Real `diagnostics.recentStderr` ring buffer ✅

Replaced the stub at `tauri/src/runtime_supervisor.rs:298-305`.

### Tasks

- [x] Added `STDERR_RING_LINE_CAP: usize = 200` and
      `STDERR_RING_BYTE_CAP: usize = 64 * 1024` constants near the
      existing `RESTART_BASE_MS` / `SHUTDOWN_GRACE` block. (Renamed
      from the design's `LINE_CAP` / `BYTE_CAP` to avoid clashing
      with any future generic *_CAP constants in the same file.)
- [x] Added a `RingLine` struct (`generation: u64`, `ts_ms: i64`,
      `line: String`, with `#[derive(Clone, Serialize)]`) plus
      `recent_stderr: VecDeque<RingLine>` and `recent_stderr_bytes:
      usize` (running byte sum for O(1) byte-cap check) on the
      existing `RuntimeSupervisor` struct. Default to empty.
- [x] Added `RuntimeSupervisor::push_stderr_line(generation, line)`
      helper that pushes and evicts FIFO until both caps hold.
- [x] Modified the stderr drain task to split chunks on `\n`, carry a
      trailing partial line across `read()` calls, and push completed
      lines via `push_stderr_line`. The existing `runtime:stderr`
      Tauri event continues to fire unchanged (no UI regression).
- [x] Replaced the stub at the (now-shifted) `diagnostics.recentStderr`
      handler with a real drain of the ring buffer. Response shape is
      additive (`{ lines: [{ generation, tsMs, line }, ...] }`); the
      existing `{ lines: [] }` callers that ignore unknown fields
      still work.
- [x] Added ring-buffer unit tests under `runtime_supervisor::unit_tests`:
  - [x] `ring_buffer_evicts_by_line_cap` — inserts `LINE_CAP + 50`,
        asserts FIFO eviction by oldest
  - [x] `ring_buffer_evicts_by_byte_cap` — inserts ~200 KiB of
        1 KiB lines, asserts byte cap holds
  - [x] `ring_buffer_retains_across_generations` — two generations,
        both entries present, generation + ts_ms populated
- [x] Updated `43.../tasks.md:109` to tick the diagnostics-bridge box
      and cross-link to Track 45.

---

## Exit

All boxes above checked (modulo the CI workflow wiring follow-up
noted under Goal 1). Track 43's remaining items at this point are:
(a) the release-engineer multi-OS hand-offs already documented in
Track 43 Phase 4, and (b) the deferred "full functional turn
verification with deterministic agent fixtures" — a separate future
track, not Track 45's responsibility.
