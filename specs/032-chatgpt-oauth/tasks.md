# Tasks: ChatGPT OAuth Subscription Authentication

**Input**: Design documents from `/specs/032-chatgpt-oauth/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Unit tests included for the core OAuth service (pure TypeScript, highly testable). Integration/E2E tests omitted (require live OpenAI OAuth endpoints).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Config type changes and core OAuth service that all stories depend on

- [X] T001 Add `authMethod` field to `IStoredProviderConfig` in `src/config/types.ts` — add optional `authMethod?: 'api_key' | 'chatgpt_oauth'` field per data-model.md ProviderAuthMethod entity
- [X] T002 Add `chatgpt_oauth` to `AgentReadyState.authMode` union type and add `isChatGPTOAuthActive?()` and `getChatGPTAccessToken?()` optional methods to `IAuthManager` interface in `src/core/models/types/Auth.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core OAuth service and Rust callback server that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Create `ChatGPTOAuthService` in `src/core/auth/ChatGPTOAuthService.ts` — implement `ChatGPTOAuthStorage` interface, `ChatGPTTokens` type, PKCE challenge generation (`generatePKCEChallenge`), authorization URL builder (`buildAuthorizationUrl`), token exchange (`exchangeCodeForTokens`), token refresh with promise mutex (`refreshAccessToken`, `getValidAccessToken`), `isAuthenticated`, and `logout` methods per contracts/chatgpt-oauth-api.md
- [X] T004 [P] Create `oauth_server.rs` Rust module in `tauri/src/oauth_server.rs` — implement `start_oauth_callback_server` Tauri command that binds TCP listener on `127.0.0.1:1455`, accepts one GET `/callback` request, extracts `code` and `state` query params, responds with success HTML page, returns `OAuthCallbackResult { code, state }`, with configurable timeout per contracts/chatgpt-oauth-api.md Tauri Command Contract
- [X] T005 Register `oauth_server::start_oauth_callback_server` command in `tauri/src/main.rs` — add `mod oauth_server;` declaration and add to the `invoke_handler` macro call alongside existing commands

### Unit Tests

- [X] T006 [P] Create unit tests for `ChatGPTOAuthService` in `tests/unit/core/auth/ChatGPTOAuthService.test.ts` — test PKCE verifier length and base64url encoding, code challenge is SHA-256 of verifier, authorization URL contains all required params (client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method), token exchange sends correct POST body (mock fetch), token refresh sends correct POST body (mock fetch), `getValidAccessToken` returns cached token when not expired, `getValidAccessToken` refreshes when expiring within 5 minutes, concurrent refresh calls share a single refresh request (mutex), `logout` clears stored tokens, `isAuthenticated` returns false when no tokens

**Checkpoint**: Foundation ready — core OAuth service tested, Rust callback server registered, config types extended. User story implementation can now begin.

---

## Phase 3: User Story 1 — Sign in with ChatGPT on Desktop (Priority: P1) MVP

**Goal**: Desktop users can click "Sign in with ChatGPT" in Settings, complete OAuth in their browser, and use OpenAI models with their subscription. Session persists across restarts.

**Independent Test**: Open Settings → click "Sign in with ChatGPT" → complete browser login → verify "Connected via ChatGPT" status → select OpenAI model → send message → verify response → restart app → verify still connected.

### Implementation for User Story 1

- [X] T007 [P] [US1] Create `ChatGPTOAuthDesktopStorage` in `src/desktop/auth/ChatGPTOAuthDesktopStorage.ts` — implement `ChatGPTOAuthStorage` interface using `KeytarCredentialStore` with service `chatgpt-oauth` and accounts `access_token`, `refresh_token`, `id_token`, `expires_at` following pattern in `src/desktop/auth/DesktopAuthService.ts:23-31`
- [X] T008 [P] [US1] Create `ChatGPTOAuthDesktopFlow` in `src/desktop/auth/ChatGPTOAuthDesktopFlow.ts` — implement `login()` method that: generates PKCE challenge via `ChatGPTOAuthService`, generates random state UUID, builds auth URL, starts Tauri callback server via `invoke('start_oauth_callback_server', { timeoutSecs: 300 })`, opens browser via `@tauri-apps/plugin-shell` `open()`, awaits callback, validates state param matches, exchanges code for tokens, stores tokens via storage adapter. Include `cancel()` and timeout handling per spec FR-014
- [X] T009 [US1] Modify `ModelClientFactory.loadConfigForProvider()` in `src/core/models/ModelClientFactory.ts` — after loading `apiKey` from config (line ~473), add check: if `provider === 'openai'` and `this.authManager?.isChatGPTOAuthActive?.()`, call `this.authManager.getChatGPTAccessToken?.()` and use returned token as `apiKey`. Also update cache key in `createClient()` to include `chatgpt_oauth` routing type
- [X] T010 [US1] Add "Sign in with ChatGPT" UI section to `src/webfront/settings/ModelSettings.svelte` — add a conditional section visible when `currentProvider === 'openai'` and user is in direct API mode. Include three states: (1) disconnected: "Sign in with ChatGPT" button with description text, (2) signing in: spinner with "Signing in..." text, (3) connected: green status indicator with "Connected via ChatGPT" text and "Disconnect" button. Wire button to `ChatGPTOAuthDesktopFlow.login()` on desktop platform. When connected, disable/hide the API key input. Use existing i18n `t()` function for all strings
- [X] T011 [US1] Add ChatGPT OAuth token restoration to `restoreAuthFromKeychain()` in `src/desktop/agent/DesktopAgentBootstrap.ts` — after existing AI Republic auth check (~line 286), add block that imports `ChatGPTOAuthDesktopStorage` and `ChatGPTOAuthService`, checks `isAuthenticated()`, and if true, creates an `AuthManager` variant with a `getChatGPTAccessToken` token getter that calls `oauthService.getValidAccessToken()` and sets `isChatGPTOAuthActive` to return `true`. Also listen for auth changes to re-run this check

**Checkpoint**: User Story 1 complete — desktop users can sign in with ChatGPT, use OpenAI models, and persist sessions across restarts.

---

## Phase 4: User Story 2 — Automatic Token Refresh (Priority: P1)

**Goal**: Access tokens are automatically refreshed before expiry so users never experience authentication interruptions during extended sessions.

**Independent Test**: Sign in with ChatGPT → wait for token to approach expiry (or mock a near-expiry token) → send a message → verify the request succeeds without re-authentication → verify new tokens stored in keychain.

### Implementation for User Story 2

- [X] T012 [US2] Add 401 retry logic for ChatGPT OAuth in `src/core/models/ModelClientFactory.ts` — when an OpenAI API call returns 401 and ChatGPT OAuth is active, attempt to refresh the token via `getChatGPTAccessToken()` (which auto-refreshes), clear client cache, and retry the request once. If refresh fails, propagate error with user-friendly message "ChatGPT session expired, please sign in again"
- [X] T013 [US2] Add refresh failure handling to Settings UI in `src/webfront/settings/ModelSettings.svelte` — when a token refresh failure is detected (via agent store `authMode` change or error event), update the ChatGPT OAuth status to show "Session expired" with a "Sign in again" button. Ensure the UI transitions from "Connected" to "Error" state per data-model.md state transitions

**Checkpoint**: User Story 2 complete — token refresh is transparent, and failures are handled gracefully with clear re-sign-in prompts.

---

## Phase 5: User Story 3 — Switch Between API Key and ChatGPT OAuth (Priority: P2)

**Goal**: Users can freely switch between API key and ChatGPT OAuth for the OpenAI provider. The two methods are mutually exclusive — activating one deactivates the other.

**Independent Test**: Connect via OAuth → verify connected → enter API key and save → verify OAuth disconnected → remove API key → click "Sign in with ChatGPT" → verify connected via OAuth.

### Implementation for User Story 3

- [X] T014 [US3] Add mutual exclusivity logic to `src/webfront/settings/ModelSettings.svelte` — when saving an API key for OpenAI while ChatGPT OAuth is connected: clear OAuth tokens via `ChatGPTOAuthService.logout()`, set `authMethod='api_key'` on the stored provider config, invalidate `ModelClientFactory` client cache, update UI to show API key as active. When ChatGPT OAuth completes while an API key exists: set `authMethod='chatgpt_oauth'`, update UI to show OAuth as active and hide/disable API key input
- [X] T015 [US3] Implement "Disconnect" action in `src/webfront/settings/ModelSettings.svelte` — wire the "Disconnect" button to call `ChatGPTOAuthService.logout()`, set `authMethod='api_key'` on stored provider config, invalidate client cache, update UI to show disconnected state with API key input re-enabled
- [X] T016 [US3] Persist `authMethod` changes in `src/config/AgentConfig.ts` — ensure that when `authMethod` is set on a provider's stored config, it is correctly serialized to `IStoredConfig.providerKeys[providerId]` and restored on next load. Verify the field survives config save/load round-trip

**Checkpoint**: User Story 3 complete — users can switch freely between auth methods with no ambiguous state.

---

## Phase 6: User Story 4 — Sign in with ChatGPT on Chrome Extension (Priority: P3)

**Goal**: Chrome extension users can sign in with ChatGPT using a tab-based OAuth flow.

**Independent Test**: Open extension sidepanel → Settings → click "Sign in with ChatGPT" → complete login in opened tab → verify tab closes → verify "Connected via ChatGPT" → send message using OpenAI model → verify response.

### Implementation for User Story 4

- [X] T017 [P] [US4] Create `ChatGPTOAuthExtensionStorage` in `src/extension/auth/ChatGPTOAuthExtensionStorage.ts` — implement `ChatGPTOAuthStorage` interface using `chrome.storage.local` with keys `chatgpt_oauth_access_token`, `chatgpt_oauth_refresh_token`, `chatgpt_oauth_id_token`, `chatgpt_oauth_expires_at` following pattern in `src/extension/storage/ChromeCredentialStore.ts`
- [X] T018 [P] [US4] Create `ChatGPTOAuthExtensionFlow` in `src/extension/auth/ChatGPTOAuthExtensionFlow.ts` — implement `login()` method that: generates PKCE challenge, generates state UUID, builds auth URL, opens auth URL in a new tab via `chrome.tabs.create()`, monitors `chrome.tabs.onUpdated` for tab URL matching `http://localhost:1455/callback`, extracts `code` and `state` from URL query params, closes the tab via `chrome.tabs.remove()`, validates state, exchanges code for tokens, stores tokens. Include 5-minute timeout and cleanup
- [X] T019 [US4] Wire extension OAuth flow in `src/webfront/settings/ModelSettings.svelte` — detect platform (desktop vs extension) and use `ChatGPTOAuthExtensionFlow` instead of `ChatGPTOAuthDesktopFlow` when running as extension. Use existing platform detection from `src/webfront/stores/platformStore.ts`
- [X] T020 [US4] Add extension service worker handler for ChatGPT OAuth state in `src/extension/background/service-worker.ts` — on service worker startup, check for stored ChatGPT OAuth tokens via `ChatGPTOAuthExtensionStorage`, and if authenticated, configure the agent's `ModelClientFactory` auth manager with a token getter similar to the desktop bootstrap

**Checkpoint**: User Story 4 complete — extension users can sign in with ChatGPT via the tab-based flow.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Error handling, edge cases, and final quality improvements across all stories

- [X] T021 Add error handling for port-in-use scenario in `src/desktop/auth/ChatGPTOAuthDesktopFlow.ts` — catch "Failed to bind port 1455" error from Tauri command, show user-friendly message via Settings UI: "Port 1455 is in use. Please close any application using this port and try again."
- [X] T022 Add error handling for OAuth timeout in `src/desktop/auth/ChatGPTOAuthDesktopFlow.ts` and `src/extension/auth/ChatGPTOAuthExtensionFlow.ts` — when timeout occurs, reset UI to disconnected state cleanly (no error modal, just return to disconnected)
- [X] T023 Verify `npm test && npm run lint` passes with all changes — run full test suite and linter, fix any failures or lint errors introduced by the feature
- [X] T024 Verify desktop build succeeds with `npm run tauri:build` — ensure Rust compilation of `oauth_server.rs` and TypeScript compilation all pass
- [X] T025 Run quickstart.md validation — follow the steps in `specs/032-chatgpt-oauth/quickstart.md` to verify end-to-end functionality on desktop

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 — core desktop flow
- **User Story 2 (Phase 4)**: Depends on Phase 3 (needs working OAuth to test refresh)
- **User Story 3 (Phase 5)**: Depends on Phase 3 (needs working OAuth to test switching)
- **User Story 4 (Phase 6)**: Depends on Phase 2 only (can run in parallel with US1-3 if needed)
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1, Desktop sign-in)**: Depends on Foundational only — the MVP
- **US2 (P1, Token refresh)**: Depends on US1 (needs working desktop OAuth)
- **US3 (P2, Auth switching)**: Depends on US1 (needs working desktop OAuth)
- **US4 (P3, Extension)**: Depends on Foundational only — independent from desktop stories

### Within Each User Story

- Storage adapters and flow coordinators can be built in parallel [P]
- Factory integration (T009) before Settings UI (T010)
- Bootstrap integration (T011) after factory integration (T009)

### Parallel Opportunities

- T001 and T002 (Setup) can run in parallel (different files)
- T003 and T004 (Foundational) can run in parallel (TypeScript vs Rust)
- T007 and T008 (US1 storage + flow) can run in parallel
- T017 and T018 (US4 storage + flow) can run in parallel
- US1+US2+US3 (desktop) and US4 (extension) can run in parallel if team capacity allows

---

## Parallel Example: User Story 1

```bash
# Launch storage and flow creation in parallel:
Task: "T007 [P] [US1] Create ChatGPTOAuthDesktopStorage in src/desktop/auth/ChatGPTOAuthDesktopStorage.ts"
Task: "T008 [P] [US1] Create ChatGPTOAuthDesktopFlow in src/desktop/auth/ChatGPTOAuthDesktopFlow.ts"

# Then sequential:
Task: "T009 [US1] Modify ModelClientFactory.loadConfigForProvider()"
Task: "T010 [US1] Add Sign in with ChatGPT UI section to ModelSettings.svelte"
Task: "T011 [US1] Add ChatGPT OAuth token restoration to DesktopAgentBootstrap.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T006)
3. Complete Phase 3: User Story 1 (T007-T011)
4. **STOP and VALIDATE**: Test desktop OAuth flow end-to-end
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Token refresh works transparently
4. Add User Story 3 → Auth switching works cleanly
5. Add User Story 4 → Extension users can use ChatGPT OAuth
6. Polish → Error handling, build verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US2 and US3 are light phases (2-3 tasks each) because they extend US1's infrastructure
- US4 is self-contained (own storage + flow) but reuses the core `ChatGPTOAuthService` from Phase 2
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
