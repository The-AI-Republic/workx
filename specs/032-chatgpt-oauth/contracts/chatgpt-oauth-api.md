# API Contracts: ChatGPT OAuth

**Feature**: 032-chatgpt-oauth
**Date**: 2026-02-24

This feature has no REST API endpoints — it's a client-side OAuth integration. The contracts below define the internal TypeScript interfaces and the external OAuth endpoints consumed.

## External OAuth Endpoints (OpenAI)

### Authorization Request

```
GET https://auth.openai.com/oauth/authorize
  ?client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http://localhost:1455/callback
  &response_type=code
  &scope=openid+profile+email
  &state={random-uuid}
  &code_challenge={sha256-base64url}
  &code_challenge_method=S256
```

### Token Exchange

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code={authorization_code}
&redirect_uri=http://localhost:1455/callback
&code_verifier={pkce_verifier}
```

**Response** (200 OK):
```json
{
  "access_token": "eyJ...",
  "refresh_token": "rt_...",
  "id_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Token Refresh

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&refresh_token={current_refresh_token}
```

**Response** (200 OK): Same shape as token exchange response (includes new refresh_token).

**Error Response** (401 Unauthorized):
```json
{
  "error": "invalid_grant",
  "error_description": "Refresh token has been revoked"
}
```

## Internal TypeScript Interfaces

### ChatGPTOAuthStorage

Platform-specific storage adapter interface.

```typescript
interface ChatGPTOAuthStorage {
  getTokens(): Promise<ChatGPTTokens | null>;
  setTokens(tokens: ChatGPTTokens): Promise<void>;
  clearTokens(): Promise<void>;
}
```

### ChatGPTTokens

```typescript
interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number; // Unix timestamp in ms
}
```

### ChatGPTOAuthService (public API)

```typescript
class ChatGPTOAuthService {
  constructor(storage: ChatGPTOAuthStorage);

  /** Generate PKCE challenge pair for a new login flow */
  generatePKCEChallenge(): Promise<{ codeVerifier: string; codeChallenge: string }>;

  /** Build the full authorization URL with PKCE and state params */
  buildAuthorizationUrl(state: string, codeChallenge: string): string;

  /** Exchange authorization code for tokens */
  exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ChatGPTTokens>;

  /** Get a valid access token, auto-refreshing if near expiry */
  getValidAccessToken(): Promise<string>;

  /** Check if authenticated (tokens exist and refresh token usable) */
  isAuthenticated(): Promise<boolean>;

  /** Clear all stored tokens */
  logout(): Promise<void>;
}
```

### IAuthManager Extensions

```typescript
interface IAuthManager {
  // Existing methods
  shouldUseBackend(): boolean;
  getBackendBaseUrl(): string | null;
  getAccessToken(): Promise<string | null>;

  // New optional methods for ChatGPT OAuth
  isChatGPTOAuthActive?(): boolean;
  getChatGPTAccessToken?(): Promise<string | null>;
}
```

### IStoredProviderConfig Extension

```typescript
interface IStoredProviderConfig {
  id: string;
  apiKey: string;
  organization?: string | null;
  authMethod?: 'api_key' | 'chatgpt_oauth'; // NEW
}
```

## Tauri Command Contract

### start_oauth_callback_server

```typescript
// TypeScript invocation
const result = await invoke<OAuthCallbackResult>(
  'start_oauth_callback_server',
  { timeoutSecs: 300 }
);

// Response type
interface OAuthCallbackResult {
  code: string;   // Authorization code from OpenAI
  state: string;  // State parameter for CSRF validation
}
```

**Errors**:
- `"Failed to bind port 1455: ..."` — Port in use
- `"OAuth callback timed out"` — No callback within timeout
- `"Missing 'code'"` — Callback missing required parameter
