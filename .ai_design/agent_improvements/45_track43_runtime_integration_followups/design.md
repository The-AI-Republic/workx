# Track 45 — Apple Pi Runtime: real-sidecar integration + verification gaps (follow-up to Track 43)

Date: 2026-05-20
Status: OPEN — P1 (closes Track 43 verification gaps; supports release-engineer multi-OS smoke)
Follows up: [Track 43 — Apple Pi Runtime Decoupling](../43_apple_pi_runtime_decoupling_DONE/design.md) (shipped PRs #246 + #255)

> Follow-up track. Track 43's design doc is **not** modified. This captures the
> code gaps that remained after the Track 43 cutover landed — specifically items
> annotated `[not-yet-real]`, `[scaffolding]`, `[stub]`, `[indirect]`, or
> `[deferred]` in `43_apple_pi_runtime_decoupling_DONE/tasks.md`.

## Why this track exists

After PR #255 the desktop **runs** on the runtime sidecar end-to-end: the
cuttable surface (storage providers, MCP/Node ports, UI cutover, OAuth, control
bridges, packaging script self-test) is shipped and the unit/contract test
suite is green.

What is **not** proven by today's CI:

1. The parity harness has never been run against a **real spawned sidecar**
   (`tasks.md:86`, `:115`). Both sides of `parity/__tests__/scenarios.test.ts`
   read from the same `SCENARIO_EVENT_SEQUENCES` lookup, so the equality check
   is tautological by construction. The harness mechanism is correct; the
   real-binding integration test is missing.
2. The Rust supervisor's lifecycle paths — spawn, handshake reject, restart,
   graceful quit, forced kill, orphan cleanup, stderr handling — have no
   directed `cargo test` coverage (`tasks.md:113`). Only helper-level
   coverage exists today.
3. The WebView relay (`RuntimeRelayTauriTransport`) has no round-trip
   integration test against a spawned runtime (`tasks.md:114`).
4. `diagnostics.recentStderr` is a stub (`tauri/src/runtime_supervisor.rs:298-305`):
   it returns `{ "lines": [] }` so callers don't break, but the runtime cannot
   actually read its own recent stderr.
5. Deeplink delivery to the runtime is **indirect**: Rust emits to WebView,
   WebView calls `auth.completeLogin` / `scheduler.trigger` runtime services
   (`tasks.md:108`). It works end-to-end; the design's preferred shape — a Rust→runtime
   control-event frame — is missing.
6. `src/desktop-runtime/protocol/frames.ts` defines a parallel
   `DesktopRuntimeFrame` discriminated union instead of reusing schemas from
   `@applepi/ws-server` (`packages/ws-server/src/frames.ts`). The two were
   intended to share definitions (`tasks.md:46`).
7. The Phase-1 "bootstrap parity vs the (now-deleted) DesktopAgentBootstrap"
   item is `[scaffolding]` (`tasks.md:58`): the wiring is there and the
   constructor contract test asserts `profile='desktop-runtime'`, but no
   per-feature assertion exists for approval defaults, managed-policy
   precedence, plan-review mode, or model selection precedence.
8. Crash/restart soaks (streaming response; MCP tool call) need a spawned
   sidecar to be exercised in CI (`tasks.md:144`, `:145`). Once the harness in
   #1 above exists, these become CI-writable rather than purely release-time.

The release-engineer hand-offs (three-OS `tauri:build` smoke, multi-OS keychain
read-through, resource footprint, startup latency, updater verification —
`tasks.md:141`, `:143`, `:149`, `:150`, `:151`, `:152`, `:165`) remain **out of
scope** for this track; they are not code work and continue to be owned by
release at tag time.

## Goals

1. **Spawned-sidecar integration harness.** Build a CI test that boots the
   real desktop runtime sidecar binary, attaches a real `ServerChannel` /
   `RuntimeRelayTauriTransport`, and runs `PARITY_SCENARIOS` end-to-end. This
   is the foundation that unblocks goals 2 and 5.
2. **Real-relay round-trip test.** Use the harness from goal 1 to assert
   WebView↔Rust↔runtime request/response and event ordering through
   `RuntimeRelayTauriTransport`.
3. **Rust supervisor lifecycle tests.** Add a `tokio::test` suite that spawns
   a fake child process and covers: successful handshake, handshake reject,
   restart with bounded backoff, graceful quit on SIGTERM, forced kill on
   timeout, orphan cleanup on parent exit, and stderr drain.
4. **Real diagnostics stderr ring-buffer.** Replace the
   `diagnostics.recentStderr` stub with a bounded ring buffer that the
   supervisor's stderr task feeds, and that the runtime can drain via the
   existing control frame.
5. **Crash/restart soak in CI.** Built on goal 1 — kill the sidecar mid-stream
   and mid-MCP-tool-call; assert UI reconnects and session continues.
6. **Direct Rust→runtime deeplink push frame.** Add the control-event frame
   shape the design called for, with the existing WebView indirection kept as
   a fallback during one release for safety.
7. **Shared frame schemas.** Consolidate `protocol/frames.ts` with
   `packages/ws-server/src/frames.ts` — either extract a shared schema package
   or have desktop-runtime import the ws-server helpers directly. Keep the
   existing `DesktopRuntimeFrame` literal tags as the source of truth.
8. **Per-feature bootstrap parity assertion.** Once a session-init test
   fixture exists, add direct assertions on the `desktop-runtime` profile
   branch of `ServerAgentBootstrap` for: approval defaults, managed-policy
   precedence, plan-review mode, model selection precedence.

## Non-goals

- Any change to Track 43's locked design decisions (profiles, storage paths,
  carrier, control-frame catalogue).
- Multi-OS packaged-build smoke, keychain read-through on three OSes,
  resource/latency benchmarks, updater verification — these remain
  release-engineer ownership at tag time per Track 43's Phase 4 split.
- New runtime features. This track only closes verification + minor
  refactor/stub gaps inherited from Track 43.

## Approach

Goals 1, 2, 5 share infrastructure — build the spawned-sidecar harness once
and reuse it. Order:

1. Land goal 1 first; goals 2 and 5 layer onto it.
2. Goals 3, 4, 6, 7, 8 are independent and can land in any order /
   parallel PRs. Goal 7 (schema consolidation) is the only one that touches
   the protocol surface — coordinate with any in-flight protocol changes
   before merging.

## Dependencies

- Track 43 _DONE — provides the runtime, supervisor, relay transport, parity
  harness mechanism, and the scenario list this track exercises against
  real bindings.
- Track 44 _DONE — runtime-owned state contract. Goal 8's parity assertions
  consume the same wiring that track 44 finalized.

## Exit criteria

- Spawned-sidecar parity test runs `PARITY_SCENARIOS` green in CI.
- `RuntimeRelayTauriTransport` round-trip test green in CI.
- `cargo test` covers each supervisor lifecycle path listed in goal 3.
- `diagnostics.recentStderr` returns a non-empty ring buffer when stderr has
  been written, with bounded size and no leak across sessions.
- Streaming-response and MCP-tool-call soaks survive an unannounced sidecar
  kill, with UI reconnect and session continuity asserted.
- A direct Rust→runtime deeplink control-event frame is in use; the WebView
  indirection is removed (or feature-flagged off by default) one release
  after the new path ships.
- `protocol/frames.ts` and `packages/ws-server/src/frames.ts` share their
  schemas (one imports the other, or both import a third).
- Per-feature parity assertions for approval / managed-policy / plan-review /
  model selection exist against the `desktop-runtime` profile branch.

When all of the above are met, this track and Track 43 are jointly DONE
modulo the release-engineer multi-OS hand-offs already documented in
Track 43 Phase 4.
