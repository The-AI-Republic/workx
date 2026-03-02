# Research: ChatGPT OAuth Subscription Authentication

**Feature**: 032-chatgpt-oauth
**Date**: 2026-02-24

## R-001: OpenAI Codex OAuth Flow Protocol

**Decision**: Use Authorization Code + PKCE (RFC 7636) with OpenAI's public client ID.

**Rationale**: This is the exact flow used by the official Codex CLI and all third-party integrations (Roo Code, Cline, OpenCode). PKCE is required because the client is public (no secret). OpenAI's auth server expects this specific flow.

**Key Parameters**:
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann` (hardcoded, public)
- Auth endpoint: `https://auth.openai.com/oauth/authorize`
- Token endpoint: `https://auth.openai.com/oauth/token`
- Redirect URI: `http://localhost:1455/callback` (fixed, registered by OpenAI)
- Scopes: `openid profile email`
- PKCE: code_verifier = 32 random bytes base64url, code_challenge = SHA-256(verifier) base64url
- State: Random UUID for CSRF protection

**Alternatives considered**:
- Device Code flow: Available as beta but requires manual code entry by user. Worse UX for desktop apps that can open a browser.
- Deep link redirect: BrowserX has `airepublic-pi://` but it's not registered with OpenAI as a valid redirect URI.

## R-002: Token Lifecycle and Refresh Strategy

**Decision**: Proactively refresh tokens when they expire within 5 minutes. Use a promise-based mutex to prevent concurrent refreshes.

**Rationale**: The Codex CLI uses the same 5-minute threshold. Access tokens are short-lived (~1 hour). Refresh tokens are single-use — each refresh returns a new refresh token that must be stored. Concurrent refresh attempts with the same refresh token cause 401 errors.

**Token format**:
- access_token: JWT, short-lived (~1 hour)
- refresh_token: opaque string, long-lived, single-use
- id_token: JWT containing user claims (ChatGPT account ID, email)
- expires_in: seconds until access_token expiry

**Alternatives considered**:
- Reactive refresh (on 401): Would cause visible request failures. Proactive refresh provides seamless UX.
- Fixed refresh interval: Unnecessary complexity; checking before each API call is sufficient.

## R-003: Desktop OAuth Callback Mechanism

**Decision**: Use a temporary Rust TCP server on `127.0.0.1:1455` via a Tauri command.

**Rationale**: OpenAI's registered redirect URI is `http://localhost:1455/callback`. The Tauri backend already has `tokio` with full features, making async TCP trivial. The server only needs to handle one HTTP GET, extract query params, respond with HTML, and shut down. No new Cargo dependencies needed.

**Alternatives considered**:
- Deep link redirect: Not possible — `airepublic-pi://` is not registered with OpenAI.
- Persistent background server: Over-engineered — server only needs to live for the few seconds of the OAuth callback.
- Node.js sidecar: BrowserX already has a sidecar, but Rust is simpler for a one-off TCP listener and avoids sidecar coordination.

## R-004: Chrome Extension OAuth Callback Mechanism

**Decision**: Open auth URL in a new tab, monitor `chrome.tabs.onUpdated` for the redirect URL, extract the code from the tab URL, close the tab.

**Rationale**: Extensions cannot bind localhost ports. However, when the browser navigates to `http://localhost:1455/callback?code=...`, the extension can intercept the URL change via the tabs API before the page loads (or after it fails to connect). The authorization code is in the URL query string, which is accessible to the extension.

**Alternatives considered**:
- `chrome.identity.launchWebAuthFlow()`: Requires the redirect URL to be `https://<extension-id>.chromiumapp.org/`, which OpenAI's auth server does not accept.
- Background service worker fetch: Cannot intercept browser redirects.

## R-005: Token-to-API-Key Integration Strategy

**Decision**: Inject the OAuth access token in `ModelClientFactory.loadConfigForProvider()` as a replacement for the API key. No changes to OpenAI client classes.

**Rationale**: Both API keys and OAuth access tokens are sent as `Authorization: Bearer <token>`. The `OpenAIResponsesClient` and `OpenAIChatCompletionClient` accept an `apiKey` parameter and use it in the Bearer header. By swapping the value at the factory level, all downstream code works unchanged.

**Integration point**: `ModelClientFactory.loadConfigForProvider()` at line 463 — after loading `apiKey` from config, check if ChatGPT OAuth is active for the `openai` provider and substitute the OAuth token.

**Alternatives considered**:
- Token getter function on client: Would require changing client constructor signatures and caching logic. Much more invasive.
- Separate client class for OAuth: Unnecessary duplication since the wire protocol is identical.

## R-006: Secure Token Storage

**Decision**: Desktop uses `KeytarCredentialStore` (OS keychain) with service `chatgpt-oauth`. Extension uses `chrome.storage.local` with key prefix `chatgpt_oauth_`.

**Rationale**: Follows the exact same patterns as the existing `DesktopAuthService` (keychain with service/account pairs) and `ChromeCredentialStore` (prefixed chrome.storage keys). No new storage mechanisms needed.

**Storage layout (desktop keychain)**:
- Service: `pi-chatgpt-oauth` (via SERVICE_PREFIX)
- Accounts: `access_token`, `refresh_token`, `id_token`, `expires_at`

**Storage layout (extension)**:
- Keys: `chatgpt_oauth_access_token`, `chatgpt_oauth_refresh_token`, `chatgpt_oauth_id_token`, `chatgpt_oauth_expires_at`

**Alternatives considered**:
- Encrypted file storage: Less secure than OS keychain, adds dependency.
- Shared storage with AI Republic tokens: Would conflate two separate auth systems. Separate storage is cleaner.

## R-007: Auth Method Mutual Exclusivity

**Decision**: Add `authMethod?: 'api_key' | 'chatgpt_oauth'` to `IStoredProviderConfig`. When one method is activated, the other is deactivated (tokens cleared or key ignored).

**Rationale**: Prevents ambiguous state where both an API key and OAuth token exist. The `authMethod` field persists the user's choice and is checked at runtime by `ModelClientFactory` to determine which credential to use.

**State transitions**:
- Save API key → set `authMethod='api_key'`, clear OAuth tokens
- Complete ChatGPT OAuth → set `authMethod='chatgpt_oauth'`, mark API key as inactive
- Disconnect OAuth → set `authMethod='api_key'`, clear OAuth tokens
- No auth configured → `authMethod` is undefined, neither active

**Alternatives considered**:
- Priority-based (OAuth > API key): Could confuse users who expect their API key to work.
- User-selectable radio button: More explicit but adds UI complexity for a rare scenario.
