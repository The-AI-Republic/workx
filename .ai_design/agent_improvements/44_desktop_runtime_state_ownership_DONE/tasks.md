# Track 44 Tasks

**Status: IMPLEMENTED (2026-05-20)**

See [`design.md`](./design.md) for the ownership matrix, runtime service contract, UI/Tauri rules, environment contract, and acceptance criteria.

## Phase 1: Audit And Contract Types

- [x] Added shared runtime state contract types in `src/core/services/runtime-state.ts`.
- [x] Added shared desktop URL resolution in `src/config/runtimeUrls.ts`.
- [x] Audited desktop auth/access consumers in `App.svelte`, `UserLoginStatus.svelte`, `Main.svelte`, `ModelSettings.svelte`, `agentStore`, and `userStore`.
- [x] Audited Tauri/Rust native capability seams in `main.rs`, `runtime_supervisor.rs`, keychain, scheduler, and desktop UI deeplink routing.
- [x] Updated focused service tests for auth/access compatibility fields.

## Phase 2: Runtime Auth And Access Source Of Truth

- [x] Added `RuntimeStateController` for runtime-owned auth, access, URL, and snapshot state.
- [x] Wired the controller from `ServerAgentBootstrap` for `profile === 'desktop-runtime'`.
- [x] Hydrated startup token state through the runtime credential/keychain bridge.
- [x] Applied current auth manager to active sessions and future session creation.
- [x] Updated `auth.getState`, `auth.completeLogin`, and `auth.logout` to return/update runtime-owned state.
- [x] Added typed `StateUpdate` events for `auth.stateChanged` and `agent.accessChanged`.
- [x] Added `agent.getAccessState`.
- [x] Kept transitional compatibility fields for existing callers.
- [x] Added `runtime.getStateSnapshot` and `runtime.getUrlConfig`.

## Phase 3: UI State Derivation Cleanup

- [x] Hydrated desktop UI startup from `runtime.getStateSnapshot`.
- [x] Updated desktop user display to derive from runtime auth state.
- [x] Removed desktop WebView profile fallback with raw OAuth token after login.
- [x] Updated chat access display to use runtime `agent.getAccessState`.
- [x] Updated `agentStore` to accept `AgentAccessState`.
- [x] Changed API-key mode toggle to wait for runtime-confirmed access state before updating local display.

## Phase 4: Tauri Capability Boundary

- [x] Kept keychain and scheduler as capability-level runtime supervisor control frames.
- [x] Renamed generic desktop deeplink event from misleading `auth-callback` to `applepi-deeplink`.
- [x] Added WebView-side consume-once dedupe for auth and scheduler deeplinks.
- [x] Kept runtime process health separate from auth/access state.

## Phase 5: Environment Parity And Packaging Proof

- [x] Unified desktop UI and runtime home/API URL resolution through `resolveRuntimeUrls`.
- [x] Updated runtime profile fetch to use the shared URL resolver.
- [x] Preserved prod home page as the default and `applepi://auth/callback` as the desktop callback.
- [x] Kept local-home testing opt-in through env/config.
- [x] Bundled the Node binary used by the desktop runtime sidecar build.
- [x] Updated sidecar package self-tests to execute the copied packaged Node binary and validate native addon loading.

## Phase 6: End-To-End Verification

- [x] Focused auth/access service tests pass.
- [x] TypeScript type-check passes.
- [x] Desktop UI build passes.
- [x] Desktop runtime sidecar build and package self-tests pass.
- [x] Server build passes.
- [x] Tauri Rust check passes.
- [x] Linux `.deb` package build passes.

## Done Criteria

- [x] Runtime is the single source of truth for desktop auth/access/profile display state and agent readiness.
- [x] UI renders runtime-owned state and no longer reconstructs desktop auth/access from profile/token heuristics.
- [x] Tauri/Rust remains a native capability and process supervision layer.
- [x] Startup, login callback, profile failure, restart hydration, new-session auth inheritance, logout, own API-key mode, URL parity, deeplink dedupe, and package runtime validation are covered by code paths and focused tests/build checks.
