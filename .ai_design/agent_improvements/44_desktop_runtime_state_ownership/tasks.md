# Track 44 Tasks

**Status: READY FOR IMPLEMENTATION (reviewed against current code 2026-05-20)**

See [`design.md`](./design.md) for the ownership matrix, runtime service contract, UI/Tauri rules, environment contract, and acceptance criteria.

## Phase 1: Audit And Contract Types

- [ ] Add a desktop runtime state ownership note near the runtime/bootstrap docs.
- [ ] Add shared redacted types for `RuntimeAuthState`, `AgentAccessState`, and `DesktopRuntimeStateSnapshot`.
- [ ] Decide the concrete type location, preferably under `src/core/services/runtime-state-types.ts` or a similarly shared core path that does not import webfront/Tauri code.
- [ ] Inventory every desktop UI read/write of auth, access mode, profile, API-key mode, agent readiness, and runtime health.
  - Current required inventory: `src/webfront/App.svelte`, `src/webfront/components/common/UserLoginStatus.svelte`, `src/webfront/pages/chat/Main.svelte`, `src/webfront/settings/ModelSettings.svelte`, `src/webfront/components/chat/ModelSelection.svelte`, `src/webfront/stores/userStore.ts`, `src/webfront/stores/agentStore.ts`, `src/webfront/stores/runtimeStatusStore.ts`.
- [ ] Inventory every Tauri command/event related to keychain, deeplink, scheduler, notification, runtime health, and window control.
  - Current required inventory: `tauri/src/main.rs`, `tauri/src/runtime_supervisor.rs`, `tauri/src/keychain_commands.rs`, `tauri/src/scheduler_commands.rs`, `src/desktop/ui/main.ts`.
- [ ] Add static guard tests preventing desktop UI from importing runtime-owned auth/session/bootstrap internals.
- [ ] Add static guard tests preventing Rust command handlers from adding product-level auth/access decisions.
- [ ] Update `src/core/services/__tests__/auth-services.test.ts` with the target `RuntimeAuthState` shape while preserving transitional aliases.
- [ ] Update `src/core/services/__tests__/agent-services.test.ts` with the target `AgentAccessState` shape while preserving existing `agent.initAuth` return fields.

## Phase 2: Runtime Auth And Access Source Of Truth

- [ ] Centralize current auth/access state inside the desktop runtime bootstrap.
  - Implementation target: `src/server/agent/ServerAgentBootstrap.ts` for the existing `profile === 'desktop-runtime'` service wiring and `currentAuthManager`.
- [ ] Hydrate startup token state through the runtime credential/keychain bridge.
- [ ] Make `auth.getState` return a redacted `RuntimeAuthState`.
  - Keep `hasValidToken` and `user` aliases until all desktop UI callers are migrated.
- [ ] Make `auth.completeLogin` persist token, set login mode, refresh profile best-effort, recompute access, and emit state events.
  - Return `{ success, state, access, user }` during migration.
- [ ] Make `auth.logout` clear token, profile, auth manager, active-session auth, future-session auth, and access state.
- [ ] Ensure API-key config changes recompute the same `AgentAccessState`.
- [ ] Ensure active sessions and future sessions receive the same current auth manager/access state.
- [ ] Emit typed `auth.stateChanged` and `agent.accessChanged` events.
- [ ] Make duplicate deeplink callback delivery idempotent.
- [ ] Add `agent.getAccessState` in `src/core/services/agent-services.ts`.
- [ ] Keep `agent.initAuth` as a compatibility wrapper that updates runtime access state and returns `{ success, isBackendRouting, access }`.
- [ ] Keep `agent.healthCheck` session-specific; do not make the UI landing access banner depend on it after migration.
- [ ] Add `runtime.getStateSnapshot` in a service module registered from `src/core/services/index.ts`.

## Phase 3: UI State Derivation Cleanup

- [ ] Hydrate UI startup from `runtime.getStateSnapshot`.
- [ ] Update `UserLoginStatus.svelte` to render runtime `auth.state` only.
- [ ] Remove desktop WebView fallback call to `fetchUserProfile(accessToken)` from `UserLoginStatus.svelte`.
- [ ] Stop leaving raw OAuth tokens in desktop UI state after `auth.completeLogin` returns; use runtime state response only.
- [ ] Update landing/chat access warnings to render runtime `agent.accessState` only.
- [ ] Replace `Main.svelte` `No Access Configured` banner conditions based on `$agentStore.authMode === 'none'` with `AgentAccessState.status/reason`.
- [ ] Remove UI heuristics that treat missing profile as logged out.
- [ ] Remove desktop startup mutation in `App.svelte` that forces `preferences.useOwnApiKey=false` from token presence.
- [ ] Remove direct UI mutation of auth/access mode unless followed by runtime-confirmed state.
- [ ] Keep local UI stores limited to display, routing, form, and pending-interaction state.
- [ ] Update `userStore` from `RuntimeAuthState` only in desktop builds.
- [ ] Update `agentStore` from `AgentAccessState` only for global access display; reserve `agent.healthCheck` for session-specific readiness details.

## Phase 4: Tauri Capability Boundary

- [ ] Verify keychain commands are capability-only and do not interpret auth modes.
- [ ] Verify deeplink capture forwards the callback exactly once.
- [ ] Prefer direct Rust-to-runtime callback delivery when the relay supports it.
- [ ] Keep WebView forwarding as transport-only if direct delivery is not ready.
- [ ] Replace or wrap the misleading `auth-callback` event name for generic `applepi://...` URLs.
- [ ] Add a central deeplink dedupe/consume-once helper covering `applepi://auth/callback` and `applepi://scheduler/trigger`.
- [ ] Verify scheduler OS registration remains capability-only and product schedule state remains runtime-owned.
- [ ] Verify runtime health/restart events are separate from auth/access state.

## Phase 5: Environment Parity And Packaging Proof

- [ ] Unify desktop UI and desktop runtime resolution for home-page base URL.
- [ ] Unify desktop UI and desktop runtime resolution for backend API base URL.
- [ ] Make `src/desktop-runtime/auth/runtimeProfileFetch.ts` consume the same effective URL config as `src/webfront/lib/constants.ts` / the login URL builder.
- [ ] Add a diagnostic/service response that reports redacted effective URL config and source.
- [ ] Keep prod home page as default; require explicit env/config for `https://localhome.airepublic.com`.
- [ ] Preserve `redirect_url=applepi%3A%2F%2Fauth%2Fcallback` in the login URL builder.
- [ ] Add regression coverage for `HOME_PAGE_BASE_URL`, `BACKEND_API_BASE_URL`, `LLM_API_URL`, and `applepi://auth/callback` consistency.
- [ ] Add package-time check that the runtime sidecar uses bundled Node.
- [ ] Add package-time check that native modules load from the packaged sidecar environment.

## Phase 6: End-To-End Tests

- [ ] Cold start with no token shows no access without false login state.
- [ ] Prod-home login callback persists token, refreshes profile, and makes agent ready.
- [ ] Local-home login callback works when local-home config is enabled.
- [ ] Profile fetch failure after token persistence still renders token-backed login state.
- [ ] App restart after login restores runtime auth/access state.
- [ ] New session after login inherits login auth manager.
- [ ] Logout clears runtime, active-session, future-session, and UI auth/access state.
- [ ] Own-API-key mode updates runtime and UI through the same access-state path.
- [ ] Duplicate deeplink callback is consumed idempotently.
- [ ] Build/package validation fails on runtime Node/native-addon mismatch.
- [ ] Compatibility test proves legacy callers still understand `auth.getState.hasValidToken`, `auth.getState.user`, `agent.initAuth.success`, and `agent.healthCheck.authMode` until the migration cleanup lands.

## Done Criteria

- [ ] The ownership matrix is reflected in code boundaries and static guards.
- [ ] Runtime is the single source of truth for auth, access, profile display state, effective config, and agent readiness.
- [ ] UI renders runtime-owned state and no longer reconstructs auth/access from local heuristics.
- [ ] Tauri/Rust owns native capabilities only.
- [ ] Prod login, local-home login, restart, logout, new-session inheritance, and own-API-key mode pass focused tests.
- [ ] Desktop package validation proves the sidecar runtime environment before install.
- [ ] Transitional compatibility fields are either documented as still required or removed after all UI callers migrate.
