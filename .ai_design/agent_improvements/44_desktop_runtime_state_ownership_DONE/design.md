# Track 44: Desktop Runtime State Ownership Contract

**Priority: P1** | **Effort: Medium-Large** | **Status: IMPLEMENTED (2026-05-20)**

Track 43 moved Apple Pi desktop from an in-WebView agent to a Rust-supervised Node runtime sidecar. That cutover is the right architecture, but the state boundary is still too implicit. Recent login/runtime debugging showed several classes of drift:

- The UI could show `Disconnected` or `Login` even when the runtime had usable token state.
- The runtime could have a token but future sessions did not reliably inherit the matching auth manager.
- The UI, desktop runtime, and home page could disagree on the effective login/home-page base URL.
- Profile lookup failures could make a token-backed login look logged out.
- Packaging could run the runtime with a different Node/native-addon environment than the app was built for.

This track makes the post-Track-43 architecture explicit and enforceable:

```
Tauri / Rust shell
  Owns native capabilities only:
  process supervision, deeplink delivery, keychain transport, tray/window,
  notification, scheduler OS registration, updater, filesystem path resolution.

Desktop runtime sidecar
  Owns durable product and agent state:
  auth state, access mode, effective config, sessions, tools, memory, scheduler,
  MCP/plugins/skills, task state, rollout storage, and agent readiness.

Svelte WebView UI
  Owns display and ephemeral interaction state only:
  current route, selected panel, transient form input, optimistic spinners.
  It renders runtime-owned state; it does not decide auth/access/readiness.
```

## Design Review Findings (2026-05-20)

Review against current `agent-improvements` code found the track is valid and implementable, with one important constraint: this must evolve the existing runtime services instead of adding a second service layer.

Current code already has the right foundation:

- `src/core/services/auth-services.ts` registers `auth.completeLogin`, `auth.getState`, `auth.logout`, and runtime-owned ChatGPT OAuth services.
- `src/core/services/agent-services.ts` registers `agent.healthCheck`, `agent.initAuth`, and global config/auth update services.
- `src/server/agent/ServerAgentBootstrap.ts` wires those services for `profile === 'desktop-runtime'` and stores `currentAuthManager`.
- `src/webfront/stores/runtimeStatusStore.ts` already derives runtime process state from Tauri supervisor events.
- `tauri/src/runtime_supervisor.rs` already exposes keychain and scheduler OS actions as control-frame capabilities.
- `src/desktop/ui/main.ts` already forwards scheduler deeplinks to runtime services, while auth deeplinks are still consumed by `UserLoginStatus.svelte`.

Remaining implementation gaps are concrete:

1. `auth.getState` returns `{ hasValidToken, user }`; Track 44 needs a versioned/redacted `RuntimeAuthState` without breaking transitional callers.
2. `auth.completeLogin` persists tokens and updates active sessions, but it does not yet return/store a full auth/access state snapshot or emit `auth.stateChanged`.
3. `agent.initAuth` is still a command-style service that UI calls directly from `App.svelte`, `UserLoginStatus.svelte`, and `ModelSettings.svelte`; Track 44 should keep it temporarily but make it an internal compatibility wrapper over runtime-owned access state.
4. `agent.healthCheck` is session-oriented and still drives UI access banners through `agentStore`; Track 44 needs a global `agent.getAccessState` for landing/chat access decisions.
5. Desktop UI still mutates `AgentConfig.preferences.useOwnApiKey` and then calls `agent.initAuth`; the runtime should own the effective access mode and publish the confirmed state back to UI.
6. `UserLoginStatus.svelte` still receives raw OAuth tokens from the deeplink event and performs a WebView profile-fetch fallback with `fetchUserProfile(accessToken)`. The runtime persists the tokens, but the UI still sees them during callback handling.
7. `App.svelte` currently forces `useOwnApiKey=false` when `auth.getState.hasValidToken` is true. That is product-state logic in the UI and should move to runtime.
8. `src/desktop-runtime/auth/runtimeProfileFetch.ts` resolves `APPLEPI_HOME_PAGE_BASE_URL` / `VITE_HOME_PAGE_BASE_URL`, while the UI uses `src/webfront/lib/constants.ts`; these should be unified through a shared desktop URL config service/snapshot.
9. Tauri emits every `applepi://...` URL as `auth-callback`, including scheduler URLs. The current routing works, but the event name and split listeners make duplicate/missed delivery harder to reason about.

Design decision after review: implement Track 44 as a **state-contract migration** in two compatibility steps:

1. Add the new runtime state services/events while preserving existing `auth.getState`, `agent.initAuth`, and `agent.healthCheck` response fields for older UI callers.
2. Migrate UI consumers to the new snapshot/events, then remove redundant UI heuristics and direct `agent.initAuth` calls.

## Problem

Track 43 correctly removed the old WebView agent bootstrap, but the follow-up bug fixes were still point repairs. Without a formal ownership contract, the same failures will reappear in nearby flows:

1. **Auth state is split.** Tokens live behind the runtime/keychain boundary, profile data is fetched through desktop-runtime code, UI components keep local login assumptions, and agent sessions need an `AuthManager`.
2. **Access state is inferred in too many places.** The UI currently has enough config and token knowledge to show `Logged In`, `Login`, or `No Access Configured` without a single runtime source of truth.
3. **Future sessions can drift from current auth.** Updating active sessions is not enough; the runtime must maintain current auth/access state and apply it to every new `Session`.
4. **Environment parity is informal.** Home page URL, login base URL, API base URL, cookie/deeplink contract, build env, and sidecar runtime env must resolve through one documented chain.
5. **Tauri can accidentally regain product logic.** Rust should deliver native capabilities and transport frames, not interpret product auth modes or agent readiness.

## Goals

- Define a state ownership matrix for desktop after Track 43.
- Make the desktop runtime the only source of truth for auth, access mode, agent readiness, effective config, and session inheritance.
- Make UI state fully derived from runtime services/events.
- Keep Tauri/Rust as a native-capability and supervision layer only.
- Add tests that catch drift across cold start, login callback, restart, logout, local-home testing, and new-session creation.
- Add build/package validation that catches runtime-sidecar environment mismatches before install.

## Non-Goals

- Do not reintroduce an in-WebView agent.
- Do not move OS keychain, tray, updater, scheduler registration, notification, or deeplink capability logic out of Tauri.
- Do not redesign the home-page OAuth backend. This track only requires a stable desktop callback contract.
- Do not make profile fetch success a prerequisite for token-backed login. Profile is display data; token/access state is product state.
- Do not change server or extension ownership rules except where shared service types need clearer names.

## Ownership Matrix

| State / Capability | Owner | UI access | Tauri/Rust role |
|---|---|---|---|
| Runtime process health | Tauri supervisor + runtime heartbeat | Subscribe to `runtime.status` | Spawn, restart, stop, expose health events |
| Auth token storage | Runtime auth service via keychain bridge | Never reads token directly | Keychain get/set/delete capability |
| Auth mode (`login`, own API key, no access) | Runtime | Subscribe/query `auth.state` and `agent.accessState` | None |
| User profile display | Runtime auth/profile service | Subscribe/query profile snapshot | None |
| Agent readiness | Runtime | Subscribe/query `agent.health` | None |
| Effective model/provider config | Runtime config service | Query/update through runtime service | None |
| Durable config storage | Runtime | Service only | Path resolution only |
| Sessions and session inheritance | Runtime | Service/events only | None |
| Memory and summaries | Runtime | Service/events only | None |
| Tools, MCP, skills, plugins | Runtime | Service/events only | Native path/process capability only where explicitly bridged |
| Scheduler product state | Runtime | Service/events only | OS alarm registration and notification capability |
| Window/tray/updater/autostart | Tauri/Rust | Commands/events | Owns native implementation |
| Deeplink delivery | Tauri/Rust transport, runtime consumes product callback | UI may forward only if Rust cannot push direct runtime event yet | Capture OS URL and deliver exactly once |

## Code-Grounded Implementation Map

| Area | Current file(s) | Required change |
|---|---|---|
| Auth service contract | `src/core/services/auth-services.ts` | Add `RuntimeAuthState`, return it from `auth.getState`, emit/auth-store state changes, keep `hasValidToken`/`user` aliases during migration. |
| Agent access contract | `src/core/services/agent-services.ts` | Add `agent.getAccessState`; make `agent.initAuth` update runtime access state and return the new state alongside existing `{ success, isBackendRouting }`. |
| Runtime bootstrap state | `src/server/agent/ServerAgentBootstrap.ts` | Add one desktop-runtime state object for auth/profile/access/effective URL config/current auth manager; apply it to active and future sessions. |
| Runtime state snapshot | New or existing service module under `src/core/services/` | Add `runtime.getStateSnapshot` using `runtimeStatus`, auth state, access state, and redacted URL/config source. |
| Desktop URL config | `src/webfront/lib/constants.ts`, `src/desktop-runtime/auth/runtimeProfileFetch.ts`, Vite env config | Replace duplicated URL resolution with shared/serialized effective desktop URL config. Runtime profile fetch and login URL builder must agree. |
| UI auth display | `src/webfront/App.svelte`, `src/webfront/components/common/UserLoginStatus.svelte`, `src/webfront/stores/userStore.ts` | Hydrate from runtime auth state; profile failure must still render logged-in token state; no WebView token/profile fallback on desktop after migration. |
| UI access display | `src/webfront/pages/chat/Main.svelte`, `src/webfront/stores/agentStore.ts` | Drive `No Access`/ready banners from `agent.getAccessState` or snapshot instead of local health heuristics. |
| API-key mode toggle | `src/webfront/settings/ModelSettings.svelte`, `src/webfront/components/chat/ModelSelection.svelte` | UI sends intent to runtime/config service; runtime confirms effective access mode before UI updates displayed mode. |
| Deeplink transport | `tauri/src/main.rs`, `src/desktop/ui/main.ts`, `src/webfront/components/common/UserLoginStatus.svelte` | Rename/normalize event payload internally as `applepi:deeplink` or direct Rust→runtime control event; centralize dedupe/consume-once. |
| Native capability bridge | `tauri/src/runtime_supervisor.rs`, `tauri/src/keychain_commands.rs`, `tauri/src/scheduler_commands.rs` | Keep keychain/scheduler/window/notification as capability-level control frames only; add guard tests or review checks. |
| Runtime status | `src/webfront/stores/runtimeStatusStore.ts` | Keep as Tauri-supervisor process health; do not mix with auth/access readiness. |
| Tests | `src/core/services/__tests__/auth-services.test.ts`, `src/core/services/__tests__/agent-services.test.ts`, webfront store/component tests, Tauri/Rust unit tests | Update expected shapes and add migration/compatibility tests. |

## Runtime Service Contract

Add or harden a small set of runtime-owned services. The names below are illustrative; implementation should use existing service naming where possible.

### `auth.getState`

Returns a redacted, renderable auth snapshot:

```ts
type RuntimeAuthState = {
  mode: 'login' | 'own_api_key' | 'none';
  hasToken: boolean;
  // Transitional compatibility for existing desktop UI callers.
  hasValidToken?: boolean;
  profile: {
    id?: string;
    email?: string;
    name?: string;
    avatar?: string;
    userType?: number;
  } | null;
  // Transitional compatibility for existing desktop UI callers.
  user?: {
    id?: string;
    email?: string;
    name?: string;
    avatar?: string;
    userType?: number;
  } | null;
  profileStatus: 'idle' | 'loading' | 'ready' | 'failed';
  updatedAt: number;
  lastError?: string;
};
```

Rules:

- Never return raw tokens.
- `hasToken: true` means the UI should render an authenticated state even if `profileStatus === 'failed'`.
- During migration, set `hasValidToken === hasToken` and `user === profile` so existing callers keep working.
- Profile fetch failures are display degradation, not access failure.
- Runtime emits `auth.stateChanged` whenever this snapshot changes.

### `auth.completeLogin`

Consumes a desktop deeplink callback and updates runtime state:

1. Validate the callback shape.
2. Persist the token through the runtime credential/keychain bridge.
3. Set runtime auth mode to `login` and effective access mode to backend-routing login.
4. Refresh profile best-effort.
5. Recompute agent access state.
6. Apply the current auth manager to active sessions and future session factories.
7. Return `{ success: true, state: RuntimeAuthState, access: AgentAccessState, user: state.profile }`.
8. Emit `auth.stateChanged` and `agent.accessChanged`.

This operation must be idempotent for duplicate deeplink delivery.

### `auth.logout`

Clears token state, profile state, runtime auth manager, and agent access state. Existing and future sessions must move to no-login unless own API key mode is active.

### `agent.getAccessState`

Returns what the UI needs to decide whether chat can run:

```ts
type AgentAccessState = {
  status: 'ready' | 'needs_login' | 'needs_api_key' | 'initializing' | 'error';
  mode: 'login' | 'api_key' | 'none';
  ready: boolean;
  provider?: string;
  model?: string;
  reason?: string;
  updatedAt: number;
};
```

Rules:

- UI must not infer this from local config, token presence, or profile presence.
- The runtime must recompute this after login, logout, API-key config changes, managed-policy changes, and runtime restart.
- New sessions must inherit the same access state as the runtime.
- During migration, `agent.healthCheck` may keep returning session-specific `{ ready, message, provider, model, authMode }`, but global banners should move to `agent.getAccessState`.

### `agent.initAuth`

Keep the existing service as a compatibility entrypoint, but narrow its role:

- It updates runtime-owned access state, not UI-owned state.
- It must call the same internal state transition used by login/logout/API-key settings.
- It returns both existing fields and the new state:

```ts
{
  success: true;
  isBackendRouting: boolean;
  access: AgentAccessState;
}
```

After UI migration, new desktop UI code should prefer a clearer service such as `agent.setAccessMode` or `config.update` + `agent.getAccessState`; `agent.initAuth` can remain for extension/server compatibility if needed.

### `runtime.getStateSnapshot`

Returns one boot-time UI hydration payload:

```ts
type DesktopRuntimeStateSnapshot = {
  runtime: {
    status: 'starting' | 'ready' | 'reconnecting' | 'failed' | 'down' | 'unknown';
    lastError?: string | null;
  };
  auth: RuntimeAuthState;
  access: AgentAccessState;
  effectiveConfig: RedactedEffectiveConfig;
  urls: {
    homePageBaseUrl: string;
    backendApiBaseUrl: string | null;
    llmApiUrl: string | null;
    deeplinkRedirectUrl: 'applepi://auth/callback';
    source: Record<string, 'env' | 'config' | 'default' | 'tauri-host'>;
  };
};
```

The UI should use this as the initial source of truth instead of reconstructing state from local stores.

Implementation note: process health currently comes from Tauri events in `runtimeStatusStore.ts`; the snapshot may report the runtime's self-view while the UI still merges it with supervisor status. Keep those concerns separate in code.

## UI Rules

- UI components may keep local interaction state, but not durable auth/access truth.
- `UserLoginStatus.svelte` renders `auth.state` and dispatches runtime service calls only.
- The landing/chat access panel renders `agent.accessState`, not local token/config heuristics.
- Settings may edit config through runtime services, but the effective state shown afterward comes back from runtime events or snapshots.
- On startup, the UI waits for `runtime.getStateSnapshot` or a bounded timeout that leaves the UI in a clear runtime-starting/runtime-error state.
- Desktop `App.svelte` must not set `preferences.useOwnApiKey=false` just because a token exists; that transition belongs in runtime login/access state.
- Desktop `UserLoginStatus.svelte` must not call `fetchUserProfile(accessToken)` after migration; desktop profile lookup belongs in runtime.
- `userStore` may remain as a display adapter, but it should be populated only from `RuntimeAuthState`.
- `agentStore` may remain as a display adapter, but it should be populated only from `AgentAccessState` or session `agent.healthCheck` where truly session-specific.

## Tauri/Rust Rules

- Rust owns process supervision, native commands, and OS capability bridges.
- Rust must not decide whether the user is logged in, whether the agent is ready, or which auth mode is active.
- Deeplink delivery should eventually be Rust → runtime direct control/event. If the WebView remains an intermediary, it must only forward the URL and consume it once.
- Rust keychain commands must be capability-level: get/set/delete/list by key. Runtime owns semantics.
- Sidecar packaging must use the bundled Node runtime and native module set that was validated during build.
- The current `auth-callback` event name is misleading because it also carries scheduler deeplinks. Track 44 should normalize this internally to a generic deeplink event or direct runtime control frame.

## Environment And Login URL Contract

Desktop has three related but separate URLs:

| Value | Meaning | Owner |
|---|---|---|
| Home page base URL | Browser-visible login/account UI, for example `https://airepublic.com` or `https://localhome.airepublic.com` | Build/runtime config |
| Backend API base URL | API used by home-page and runtime profile calls | Build/runtime config |
| Deeplink redirect URL | Desktop callback, currently `applepi://auth/callback` | Product contract |

Requirements:

- Desktop UI and desktop runtime resolve the same effective home/API URLs.
- Local-home testing must be opt-in through env/config, not hardcoded as the default.
- The login URL builder must preserve `redirect_url=applepi%3A%2F%2Fauth%2Fcallback`.
- The home page must be able to route back without relying on stale Svelte assets or browser cache state.
- Runtime profile fetch must use the same API/home config that produced the login URL.
- A diagnostic command should print the effective URLs and whether they came from env, config, or defaults.
- Existing defaults remain production URLs. `https://localhome.airepublic.com` must be opt-in for local testing only.

## Implementation Plan

### Phase 1: Audit And Contract Types

- Add a short architecture doc or module comment that records the ownership matrix.
- Introduce shared redacted types for `RuntimeAuthState`, `AgentAccessState`, and `DesktopRuntimeStateSnapshot`.
- Add a runtime-owned state holder in the desktop-runtime bootstrap path. It should track auth state, access state, profile status, current auth manager, and URL config source.
- Add static guard tests that prevent desktop UI from importing runtime-owned auth/session/bootstrap internals.
- Add static guard tests that prevent Rust command handlers from adding product-level auth/access decisions.
- Update service tests first so the migration is pinned before UI changes.

### Phase 2: Runtime Auth And Access Source Of Truth

- Centralize current auth/access state inside the desktop runtime bootstrap.
- Ensure `auth.completeLogin`, `auth.logout`, API-key config changes, and startup token hydration all update the same state machine.
- Ensure the current auth manager is applied to both active sessions and future sessions.
- Make profile fetch best-effort and separately represented as `profileStatus`.
- Emit typed `auth.stateChanged` and `agent.accessChanged` events.
- Keep compatibility response fields until UI consumers are migrated:
  - `auth.getState.hasValidToken`
  - `auth.getState.user`
  - `auth.completeLogin.user`
  - `agent.initAuth.success`
  - `agent.initAuth.isBackendRouting`
  - `agent.healthCheck.authMode`

### Phase 3: UI State Derivation Cleanup

- Update login/account UI to consume `auth.getState` and `auth.stateChanged`.
- Update landing/chat access warnings to consume `agent.getAccessState`.
- Remove local heuristics that treat profile fetch failure as logged out.
- Remove UI code that directly mutates auth mode without waiting for a runtime-confirmed state update.
- Remove desktop-only profile fallback from `UserLoginStatus.svelte`.
- Remove desktop startup `useOwnApiKey=false` mutation from `App.svelte`.
- Change the chat `No Access Configured` banner to use `AgentAccessState.status` and `reason`.

### Phase 4: Tauri Capability Boundary

- Verify keychain, deeplink, scheduler, notification, and window bridges are capability-only.
- Make deeplink callback delivery idempotent and single-consumer.
- Prefer direct Rust → runtime callback delivery if the relay supports it; otherwise keep WebView forwarding as a temporary transport-only bridge with a central dedupe helper.
- Keep process restart and health events separate from auth/access state.
- Rename or wrap the current `auth-callback` event internally so scheduler and auth URLs are not treated as the same semantic event.

### Phase 5: Environment Parity And Packaging Proof

- Unify desktop UI and runtime env resolution for home/API URLs.
- Add a diagnostic/service response exposing redacted effective URL config and source.
- Add package-time checks that the sidecar uses bundled Node and can load native modules.
- Add local-home smoke instructions and keep prod home page as the default path.
- Make `runtimeProfileFetch.ts` consume the same effective URL config as the login URL builder.
- Add a regression test for `HOME_PAGE_BASE_URL`, `BACKEND_API_BASE_URL`, `LLM_API_URL`, and `applepi://auth/callback`.

### Phase 6: End-To-End Tests

- Add tests for cold start with no token.
- Add tests for login callback with profile success.
- Add tests for login callback with profile failure but token success.
- Add tests for app restart after login.
- Add tests for new session creation after login.
- Add tests for logout.
- Add tests for own-API-key mode.
- Add tests for local-home URL config.
- Add tests for duplicate deeplink callback delivery.

## Suggested Implementation Order

1. Add shared types and service tests for the target response shapes.
2. Add a runtime state holder and update `auth-services.ts` / `agent-services.ts` to write through it.
3. Add `agent.getAccessState` and `runtime.getStateSnapshot`.
4. Update `App.svelte`, `UserLoginStatus.svelte`, `agentStore`, and `Main.svelte` to consume runtime state.
5. Clean up `ModelSettings.svelte` / `ModelSelection.svelte` so API-key mode is a runtime-confirmed state.
6. Normalize deeplink delivery/dedupe.
7. Unify URL config and package diagnostics.
8. Remove transitional UI heuristics after tests pass.

## Acceptance Criteria

- Fresh install starts with a clear runtime status and no false login state.
- Login through prod home page returns to `applepi://auth/callback`, persists auth, shows profile when available, and makes the agent ready.
- Login through local-home works when local-home env/config is explicitly enabled.
- If profile fetch fails after token persistence, UI still shows token-backed login state with a profile warning rather than `Login`.
- Restarting Apple Pi after login restores auth/access state without another login.
- Creating a new chat/session after login inherits the login auth manager.
- Logout clears runtime auth state, active sessions, future sessions, and UI display state.
- Switching to own API key mode updates runtime access state and UI through the same service/event path.
- Tauri/Rust code contains no product-level auth/access branching beyond native capability delivery.
- Build/package validation fails if the runtime sidecar would use an unvalidated system Node/native-addon combination.
- Existing desktop UI keeps working during the migration because compatibility fields remain until all consumers move to the new state contract.

## Validation Commands

Use the repo's current commands when implementing:

```bash
npm run build:desktop-runtime-sidecar
npm run build:desktop
cargo check --manifest-path tauri/Cargo.toml
./build.sh --bundles deb
```

Add focused unit/integration tests as the implementation introduces stable seams.

## Relationship To Other Tracks

- **Track 43** created the sidecar architecture. This track hardens its state ownership and post-cutover correctness.
- **Track 04 / 29** typed background task state remains runtime-owned and should use the same UI-derived-state pattern.
- **Track 05 / 30** memory state remains runtime-owned and should not be exposed through Tauri product logic.
- **Track 35** reactive config staleness solved core agent config drift. This track applies the same idea to desktop runtime/UI/Tauri boundaries.
