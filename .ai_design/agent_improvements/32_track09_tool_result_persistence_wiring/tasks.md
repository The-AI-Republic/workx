# Track 32 — Tasks

Follows up [Track 09](../09_tool_result_persistence_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — RepublicAgent accepts services

- [ ] 1.1 Let `RepublicAgent` accept an optional pre-built `SessionServices` (or deps) and
      pass it to the existing service-aware `new Session(...)` path instead of `undefined`.
- [ ] 1.2 Integration test: a real `RepublicAgent`→`Session` built for a client platform has
      `getToolResultStore()` non-undefined (the test PR #213 lacked).

## Phase 2 — Client platform wiring (extension / desktop / mobile)

- [ ] 2.1 Build `SessionServices` with `sessionCache` = `SessionCacheManager(dbAdapter)`,
      reusing the construction pattern at `StorageTool.ts:379`.
- [ ] 2.2 Pass it through extension service worker, `DesktopAgentBootstrap`, mobile bootstrap.
- [ ] 2.3 Decide shared-vs-dedicated `SessionCacheManager` instance (namespace if shared).

## Phase 3 — Server wiring

- [ ] 3.1 In `src/server/agent/ServerAgentBootstrap.ts`, set
      `serverRootDir = join(dataDir, 'sessions')` and pass services to `RepublicAgent`.
- [ ] 3.2 Confirm `createToolResultStore` server-path throw (`resultStore.ts:334-335`) no
      longer fires (canary that wiring works).

## Phase 4 — End-to-end validation (all 4 platforms)

- [ ] 4.1 Oversized result → persisted; in-context message = preview + pointer.
- [ ] 4.2 Agent read-back returns full content.
- [ ] 4.3 Tier-2 budget enforcement triggers via the store.
- [ ] 4.4 Session close removes persisted results; server TTL sweep removes stale ones.
- [ ] 4.5 Resume seeding re-links persisted content (`Session.ts:2410-2426`).

## Phase 5 — Eviction coordination

- [ ] 5.1 Define the eviction tier for persisted tool results jointly with Track 29 G3
      (`TieredEvictor` ordering) so the two follow-ups agree.

## Exit criteria

- `getToolResultStore()` returns a real store in every shipped build.
- Track 09's exit criteria pass on extension, desktop, mobile, and server.
- A regression test guards against `Session` being constructed with `services: undefined`
  on the production path again.
