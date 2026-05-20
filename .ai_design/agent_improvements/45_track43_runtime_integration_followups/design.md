# Track 45 — Apple Pi Runtime: real-sidecar integration + verification gaps (follow-up to Track 43)

Date: 2026-05-20
Status: OPEN — P1 (closes the two highest-value Track 43 verification gaps plus one stub)
Follows up: [Track 43 — Apple Pi Runtime Decoupling](../43_apple_pi_runtime_decoupling_DONE/design.md) (shipped PRs #246 + #255)

> Follow-up track. Track 43's design doc is **not** modified. This captures
> the verification gaps that remained after the Track 43 cutover landed — the
> three items where shipped behavior depends on code we have not yet
> exercised in CI. Lower-priority items from Track 43's annotations
> (frame-schema consolidation, per-feature bootstrap parity assertion,
> direct Rust→runtime deeplink push frame, relay round-trip test) are
> intentionally **not** in scope here — they are nice-to-have refactors or
> derivatives of goal 1 and can be picked up opportunistically as
> PR-sized improvements without their own track.

## Why this track exists

After PR #255 the desktop **runs** on the runtime sidecar end-to-end: the
cuttable surface (storage providers, MCP/Node ports, UI cutover, OAuth,
control bridges, packaging script self-test) is shipped and the
unit/contract test suite is green.

What is **not** proven by today's CI:

1. The parity harness has never been run against a **real spawned sidecar**
   (`43.../tasks.md:86`, `:115`). Both sides of
   `parity/__tests__/scenarios.test.ts` read from the same
   `SCENARIO_EVENT_SEQUENCES` lookup, so the equality check is tautological
   by construction. The harness mechanism is correct; the real-binding
   integration test is missing.
2. The Rust supervisor's lifecycle paths — spawn, handshake reject, restart,
   graceful quit, forced kill, orphan cleanup, stderr handling — have no
   directed `cargo test` coverage (`43.../tasks.md:113`). Only helper-level
   coverage exists today. The supervisor is the long-running OS-level
   component; lifecycle bugs are real production risk.
3. `diagnostics.recentStderr` is a stub
   (`tauri/src/runtime_supervisor.rs:298-305`): it returns `{ "lines": [] }`
   so callers don't break, but the runtime cannot actually read its own
   recent stderr. Small, contained gap — fixing it removes a known lie from
   the control surface.

The release-engineer hand-offs (three-OS `tauri:build` smoke, multi-OS
keychain read-through, resource footprint, startup latency, updater
verification) remain **out of scope** for this track; they are not code
work and continue to be owned by release at tag time per Track 43 Phase 4.

## Goals

1. **Spawned-sidecar integration harness + parity scenarios.** Build a CI
   test that boots the real desktop runtime sidecar binary, attaches a
   real `ServerChannel`, and runs `PARITY_SCENARIOS` end-to-end against it.
   This replaces the existing tautological lookup-vs-lookup assertion in
   `parity/__tests__/scenarios.test.ts` with a genuine integration test.
2. **Rust supervisor lifecycle tests.** Add a `tokio::test` suite that
   spawns a fake child-process binary and covers: successful handshake,
   handshake reject, restart with bounded backoff, graceful quit on
   SIGTERM, forced kill on shutdown timeout, orphan cleanup, and the
   stderr drain.
3. **Real diagnostics stderr ring-buffer.** Replace the
   `diagnostics.recentStderr` stub with a bounded ring buffer that the
   supervisor's existing stderr task feeds, and that the runtime drains
   via the existing control frame.

## Non-goals (intentional)

- **Frame-schema consolidation** between `src/desktop-runtime/protocol/frames.ts`
  and `packages/ws-server/src/frames.ts`. The two schemas have not drifted in
  practice; consolidate opportunistically when one of them next changes.
- **Direct Rust→runtime deeplink push frame.** The current WebView-routed
  indirection works end-to-end. Adding the design-preferred shape is pure
  design purity and is deferred until a real driver for it emerges.
- **Per-feature bootstrap parity assertion vs the deleted
  `DesktopAgentBootstrap`.** Wiring is already exercised by the dev boot;
  asserting against a deleted reference risks test theater.
- **WebView relay round-trip integration test** as a separate goal. Once
  goal 1's harness exists, this is a small additive PR and does not need
  its own tracked work.
- **Crash/restart soak in CI** as a separate goal. Same reason as the relay
  round-trip — opportunistic add-on once goals 1+2 land, not standalone.
- **Multi-OS packaged-build smoke** and other release-engineer items —
  remain Track 43 Phase 4 hand-offs at tag time.

## Approach

Goals 1, 2, 3 are independent and can land in any order / parallel PRs.
Suggested ordering: goal 3 first (smallest, no infrastructure needed),
then goal 2, then goal 1 (largest — sets up real-sidecar CI infrastructure).

## Dependencies

- Track 43 _DONE — provides the runtime, supervisor, relay transport,
  parity harness mechanism, and the scenario list that goal 1 exercises
  against a real binding.

## Exit criteria

- `PARITY_SCENARIOS` runs green in CI against a real spawned sidecar
  binary; the tautological scenarios test is removed or marked as a
  mechanism-only smoke.
- `cargo test` covers each supervisor lifecycle path listed in goal 2.
- `diagnostics.recentStderr` returns a non-empty bounded ring buffer when
  stderr has been written, with documented size and eviction policy, and
  no leak across sessions.

When all three are met, Track 45 closes. Track 43's remaining items at
that point are exclusively release-engineer multi-OS hand-offs already
documented in Track 43 Phase 4.
