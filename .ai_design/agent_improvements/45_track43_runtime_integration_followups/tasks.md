# Track 45 Tasks

**Status (2026-05-20): OPEN — follow-up to Track 43, trimmed to essentials.**

Closes the three highest-value verification gaps from Track 43:
1. Real spawned-sidecar parity test (replaces tautological CI lookup)
2. Rust supervisor lifecycle `tokio::test` suite
3. Real `diagnostics.recentStderr` ring-buffer (replaces stub)

Out of scope by intention (see `design.md` non-goals): frame-schema
consolidation, direct Rust→runtime deeplink push frame, per-feature
bootstrap parity assertion vs deleted code, relay round-trip test, crash/
restart soak in CI, and any multi-OS / release-time items still owned by
Track 43 Phase 4.

See [`design.md`](./design.md) for context and the explicit deferral list.

## Goal 1: Spawned-sidecar parity test (replaces tautological CI)

- [ ] Add a test helper that builds + spawns the desktop runtime sidecar
      binary in a CI worker, attaches a real `ServerChannel`, and tears it
      down deterministically.
      (`src/desktop-runtime/parity/__tests__/spawnedSidecar.harness.ts`)
- [ ] Add an integration test
      `src/desktop-runtime/parity/__tests__/spawnedSidecar.scenarios.test.ts`
      that runs every entry in `PARITY_SCENARIOS` against the spawned sidecar
      and asserts the canonical event sequence.
- [ ] Remove or downgrade the existing tautological
      `src/desktop-runtime/parity/__tests__/scenarios.test.ts` so it no
      longer reads as proof of parity (keep as mechanism-only smoke if
      useful; otherwise delete).
- [ ] Wire the harness into CI for Linux. macOS/Windows runs stay at
      release time per Track 43 Phase 4.

## Goal 2: Rust supervisor lifecycle `tokio::test` suite

- [ ] Add a fake-child-process binary under `tauri/tests/fixtures/` that
      the supervisor tests can spawn. It must support the canonical
      handshake plus configurable failure modes (refuse handshake, exit
      after N frames, ignore SIGTERM, etc.).
- [ ] Add `#[tokio::test]` cases in `tauri/src/runtime_supervisor.rs` (or
      a sibling test module) covering:
  - [ ] Successful spawn + `hello`/`hello-ok` handshake
  - [ ] Handshake reject — wrong nonce
  - [ ] Handshake reject — wrong protocol version
  - [ ] Restart with bounded backoff on unexpected exit
  - [ ] Graceful quit on SIGTERM (POSIX) and the Windows equivalent
  - [ ] Forced kill after shutdown-timeout when child ignores SIGTERM
  - [ ] Orphan cleanup when the parent exits without quitting
  - [ ] stderr drain captures output without blocking stdout protocol frames

## Goal 3: Real `diagnostics.recentStderr` ring-buffer

- [ ] Replace the stub at `tauri/src/runtime_supervisor.rs:298-305` with a
      bounded ring buffer fed by the existing supervisor stderr task. The
      control-frame handler returns the buffer's current contents.
- [ ] Decide and document the buffer policy in code comments: line cap
      and/or byte cap, retention across sidecar restarts within one
      supervisor lifetime, and eviction on supervisor shutdown.
- [ ] Add a unit test (using the fake-child fixture from Goal 2) that
      writes N stderr lines and asserts the buffer contents match the
      documented policy.

## Exit

All boxes above checked. At that point Track 43's only remaining items are
the release-engineer multi-OS hand-offs already documented in Track 43
Phase 4 — and both tracks can be considered closed for code purposes.
