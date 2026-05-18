# Track 32 — Tool Result Persistence: production wiring (follow-up to Track 09)

Date: 2026-05-15
Status: OPEN — P1 (entire Track 09 feature is inert in shipped builds)
Follows up: [Track 09 — Tool Result Persistence](../09_tool_result_persistence_DONE/design.md) (shipped PR #213)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`)

> Follow-up track. Track 09's design doc is **not** modified. This captures the production
> integration gap that keeps the shipped Track 09 subsystem inert in normal boots.

## Why this track exists

Track 09's subsystem is implemented to spec and unit-tested in isolation: `ToolResultStore`,
`CacheToolResultStore`, `FileToolResultStore`, the factory, `toolLimits`,
`ContentReplacementState`, tier-1/tier-2 budget enforcement, the `read_persisted_result`
server tool, rollout schema, and cleanup. **None of it runs in any shipped build**, because
no production bootstrap injects the services that own the store.

This is exactly the "✅ shipped but unverified" failure mode: the unit tests pass because
they construct stores directly, masking the fact that the production code path never gets one.

## Verified gap (production wiring root cause)

- `RepublicAgent` is the sole production `Session` constructor:
  `src/core/RepublicAgent.ts:74` → `new Session(this.config, true, undefined, this.toolRegistry, initialHistory)`
  — the **services argument is `undefined`** on extension, desktop, server, and mobile.
- `Session` now has a service-aware constructor path and will construct a
  `ContentReplacementState` / tool-result store when the caller supplies services. That
  means the missing capability is no longer inside `Session`; the remaining production gap
  is that the `RepublicAgent` path still passes `undefined`.
- `Session.getToolResultStore()` returns the store only if services were supplied; with the
  current `RepublicAgent` construction it still returns `undefined` in shipped boots.
- `TurnManager` short-circuits both persistence tiers when there is no store:
  `src/core/TurnManager.ts:927` and `:1017` (`this.session.getToolResultStore?.()` → undefined → early return).
- `createSessionServices` exists (`src/core/session/state/SessionServices.ts:134`) and
  `Session` can consume `sessionCache` / `serverRootDir`, but no bootstrap calls the factory
  for the `RepublicAgent` path with those backing services. The fallback services created
  during session initialization are minimal runtime services, not the storage services that
  make Track 09 active.

Net effect: oversized tool results are **not** persisted on any platform; the agent's
`read_persisted_result` path is never reachable; tier-2 budget enforcement never triggers via
the store; session-close cleanup has nothing to clean. The feature is dead code in shipped
builds.

## Goals

1. Construct a `SessionServices` in every production bootstrap and pass it through
   `RepublicAgent` to the already service-aware `Session`, so `getToolResultStore()`
   returns a real store.
2. Populate platform-correct backends:
   - extension / desktop / mobile → `sessionCache` backed by a `SessionCacheManager`
     (`CacheToolResultStore`)
   - server → `serverRootDir` (e.g. `join(dataDir, 'sessions')`) (`FileToolResultStore`)
3. Prove the end-to-end Track 09 exit criteria on all four platforms (oversized result
   persisted → agent reads full content back → tier-2 enforced → close removes results).

## Non-goals

- Any change to the Track 09 store/tier/cleanup logic — it is correct; only the wiring is
  missing.
- New storage backends beyond cache (client platforms) and filesystem (server).

## Approach

- Add a single shared helper (or reuse `createSessionServices`) invoked by each bootstrap:
  - `RepublicAgent` accepts an optional pre-built `SessionServices` (or the deps to build
    one) and passes it as the `Session` services argument instead of `undefined`. Preserve
    the existing `Session` service-aware constructor; the change is to the production
    caller path.
  - Extension service worker / `DesktopAgentBootstrap` / mobile bootstrap: build
    `SessionServices` with `sessionCache: new SessionCacheManager(dbAdapter)` (a
    `SessionCacheManager` is already constructed for `StorageTool` at
    `src/tools/StorageTool.ts:379` / `src/extension/tools/StorageTool.ts:379` — reuse that
    construction pattern / instance).
  - `ServerAgentBootstrap` (`src/server/agent/ServerAgentBootstrap.ts`): set
    `serverRootDir = join(dataDir, 'sessions')` before constructing `RepublicAgent`;
    `createToolResultStore` already throws if it is missing on the server platform
    (`src/tools/resultStore.ts:334-335`) — that throw becomes the canary the wiring works.
- Keep the services object the single source of truth so the same instance feeds
  `getToolResultStore()`, cleanup on session close, and the rollout resume-seeding path.

## Risks

- **Quota interaction**: persisting large results into the cache competes with Track 04
  task-output and other cache users. Coordinate with the `StorageQuotaManager`/`TieredEvictor`
  tier model (see Track 29 G3) so persisted tool results have a defined eviction tier.
- **Server path divergence**: server uses filesystem, not cache — ensure `serverRootDir` is
  writable and cleaned by the existing server TTL sweep (`toolResultCleanup.ts`).
- **Resume seeding**: confirm `Session` resume seeding (`Session.ts:2410-2426`) gets the same
  store instance so replayed rollouts re-link persisted content.

## Validation

Per platform (extension, desktop, mobile, server):
1. Produce a tool result above the persistence threshold → assert a `PersistedResult` is
   written (cache entry / file present), and the in-context message is the preview + pointer.
2. Agent invokes the read-back path (`read_persisted_result` server tool / cache retrieve) →
   full content returned.
3. Tier-2 budget enforcement triggers via the store under accumulated pressure.
4. Session close removes persisted results (and server TTL sweep removes stale ones).
5. Add an integration test that constructs the **real** `RepublicAgent` → `Session` for at
   least one client platform and one server config and asserts `getToolResultStore()` is
   non-undefined (the test the original PR lacked, which masked this gap).

## Open questions

1. Should client platforms share the existing `StorageTool` `SessionCacheManager` instance
   or get a dedicated one? (Shared avoids double DB adapters; needs namespace separation.)
2. Eviction tier for persisted tool results vs Track 04 task output — resolve jointly with
   Track 29 G3 so the two follow-ups agree on the `TieredEvictor` ordering.
