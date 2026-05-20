# Track 45 Tasks

**Status (2026-05-20): OPEN — follow-up to Track 43.**

Closes the `[not-yet-real]`, `[scaffolding]`, `[stub]`, `[indirect]`, and
`[deferred]` items left after Track 43's cutover. Out of scope: multi-OS
packaged-build smoke and other release-engineer items still owned by Track 43
Phase 4 hand-offs.

See [`design.md`](./design.md) for the gap inventory and goals.

## Goal 1: Spawned-sidecar integration harness (foundation)

- [ ] Add a test helper that builds + spawns the desktop runtime sidecar
      binary in a CI worker, attaches a real `ServerChannel`, and tears it
      down deterministically. (`src/desktop-runtime/parity/__tests__/spawnedSidecar.harness.ts`)
- [ ] Add a CI integration test `parity/__tests__/spawnedSidecar.scenarios.test.ts`
      that runs every entry in `PARITY_SCENARIOS` against the spawned sidecar
      and asserts the canonical event sequence. Replaces the tautological
      lookup-vs-lookup assertion in the existing `scenarios.test.ts`.
- [ ] Wire the harness into the CI matrix so it runs on at least Linux for
      every PR (macOS/Windows runs at release time stay with Track 43 Phase 4).

## Goal 2: WebView relay round-trip test

- [ ] Add an integration test that drives `RuntimeRelayTauriTransport`
      through the spawned sidecar from Goal 1: request → response, ordered
      event stream, large frame (≤ 64 MB), shutdown handshake. Replaces the
      WebView-only coverage in
      `src/core/messaging/transports/__tests__/transports.test.ts`.
- [ ] Run `PARITY_SCENARIOS` through the Rust relay path (`RuntimeRelayTauriTransport`)
      to satisfy Track 43 task line 115.

## Goal 3: Rust supervisor lifecycle tests

- [ ] Add a `tokio::test` module under `tauri/src/runtime_supervisor.rs` (or a
      sibling file) using a fake child process binary in `tauri/tests/fixtures/`
      that the test orchestrates. Cover:
  - [ ] Successful spawn + `hello`/`hello-ok` handshake.
  - [ ] Handshake reject (wrong nonce, wrong version).
  - [ ] Restart with bounded backoff on unexpected exit.
  - [ ] Graceful quit on SIGTERM (POSIX) / equivalent on Windows.
  - [ ] Forced kill on shutdown-timeout.
  - [ ] Orphan cleanup when the parent exits without quitting.
  - [ ] stderr drain captures output without blocking stdout protocol frames.

## Goal 4: Real diagnostics stderr ring-buffer

- [ ] Replace the `diagnostics.recentStderr` stub at
      `tauri/src/runtime_supervisor.rs:298-305` with a bounded ring buffer
      (size + retention policy decided in PR). The supervisor's existing
      stderr task feeds it; the control-frame handler drains it.
- [ ] Decide and document the buffer policy: line cap, byte cap, eviction on
      restart, and whether buffer survives across sidecar restarts within one
      supervisor lifetime.
- [ ] Add a unit test that writes N lines to stderr in the fake-child fixture
      from Goal 3 and asserts the ring-buffer contents.

## Goal 5: Crash/restart soak in CI

- [ ] Streaming-response soak: start a streaming chat through the spawned
      sidecar, kill the sidecar mid-stream, assert supervisor restarts,
      reconnects, and the session is recoverable. (Track 43 task line 144.)
- [ ] MCP tool-call soak: same, but kill mid-MCP-tool-call. (Track 43 task
      line 145.)
- [ ] Mark the test "slow" so it can be gated to nightly if PR runtime
      pressure requires it.

## Goal 6: Direct Rust→runtime deeplink push frame

- [ ] Add a `control-event` frame variant for `deeplink.received` (auth +
      scheduler payloads) emitted from Rust to runtime directly. Update the
      frame catalogue in `src/desktop-runtime/protocol/frames.ts`.
- [ ] Add the runtime-side handler that dispatches the payload to the same
      `auth.completeLogin` / `scheduler.trigger` service paths used today.
- [ ] Keep the existing WebView-routed path behind a feature flag for one
      release as a fallback; remove the indirection after a release of
      stable telemetry.

## Goal 7: Shared frame schemas

- [ ] Consolidate `src/desktop-runtime/protocol/frames.ts` with
      `packages/ws-server/src/frames.ts`. Either:
  - extract a third shared package (`@applepi/protocol-frames`) that both
    consume, or
  - have desktop-runtime import the ws-server helpers directly.
- [ ] Preserve the existing `DesktopRuntimeFrame` literal tags as the
      authoritative names; do not rename frame types.
- [ ] Add a type-level test that the carrier roundtrips every variant.

## Goal 8: Per-feature bootstrap parity assertion

- [ ] Build the session-init test fixture referenced in Track 43 task line 58
      (the prerequisite for this assertion). Goal: a minimal `RepublicAgent`
      construction with the `desktop-runtime` profile that can be introspected
      without booting a real channel.
- [ ] Add assertions for the desktop-runtime profile branch of
      `ServerAgentBootstrap`:
  - [ ] Approval defaults match the deleted DesktopAgentBootstrap values.
  - [ ] Managed-policy precedence matches.
  - [ ] Plan-review mode matches.
  - [ ] Model selection precedence matches.

## Exit

All boxes above checked. Re-evaluate Track 43's README row and consider
collapsing the two tracks under a single ✅ DONE entry referencing both PR
sets, with the multi-OS hand-offs still listed as the release-time
responsibility they always were.
