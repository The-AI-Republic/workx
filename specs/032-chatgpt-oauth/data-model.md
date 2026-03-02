# Data Model: ChatGPT OAuth Subscription Authentication

**Feature**: 032-chatgpt-oauth
**Date**: 2026-02-24

## Entities

### ChatGPTTokens

Represents the set of OAuth tokens obtained from OpenAI's auth server.

| Field | Type | Description |
|-------|------|-------------|
| accessToken | string | Short-lived JWT used as Bearer token for API calls (~1 hour) |
| refreshToken | string | Long-lived opaque token used to obtain new access tokens. Single-use. |
| idToken | string (optional) | JWT containing user profile claims (account ID, email) |
| expiresAt | number | Unix timestamp (ms) when the access token expires |

**Lifecycle**:
- Created: After successful code-for-token exchange
- Updated: After each token refresh (new access + refresh tokens)
- Deleted: On user disconnect or refresh failure

**Storage**:
- Desktop: OS Keychain (`pi-chatgpt-oauth` service, one account per field)
- Extension: `chrome.storage.local` (keys prefixed `chatgpt_oauth_`)

### PKCEChallenge

Ephemeral challenge pair generated for each OAuth login attempt. Never persisted.

| Field | Type | Description |
|-------|------|-------------|
| codeVerifier | string | 32 random bytes, base64url-encoded |
| codeChallenge | string | SHA-256 hash of codeVerifier, base64url-encoded |

**Lifecycle**:
- Created: At the start of each login flow
- Used: codeChallenge sent in auth URL; codeVerifier sent in token exchange
- Deleted: Garbage collected after login completes or times out

### ProviderAuthMethod (extension to IStoredProviderConfig)

Tracks which authentication method is active for a given provider.

| Field | Type | Description |
|-------|------|-------------|
| authMethod | `'api_key'` \| `'chatgpt_oauth'` (optional) | Active auth method. Undefined means no auth configured. |

**Lifecycle**:
- Set to `'chatgpt_oauth'`: When user completes ChatGPT OAuth flow
- Set to `'api_key'`: When user saves an API key or disconnects OAuth
- Cleared: When all auth is removed

**Storage**: Persisted in `IStoredConfig.providerKeys[providerId]` alongside existing `apiKey` and `organization` fields.

## State Transitions

### OAuth Connection State

```
                    ┌──────────────┐
                    │ Disconnected │◄─────────────────┐
                    └──────┬───────┘                  │
                           │ User clicks              │ Disconnect / Refresh fails /
                           │ "Sign in with ChatGPT"   │ Save API key
                           ▼                          │
                    ┌──────────────┐                  │
                    │  Signing In  │──── Timeout ─────┘
                    └──────┬───────┘      (5 min)
                           │ OAuth callback
                           │ received + tokens obtained
                           ▼
                    ┌──────────────┐
              ┌────▶│  Connected   │◄─────┐
              │     └──────┬───────┘      │
              │            │              │
              │            │ Token near   │ Refresh
              │            │ expiry       │ succeeds
              │            ▼              │
              │     ┌──────────────┐      │
              │     │  Refreshing  │──────┘
              │     └──────┬───────┘
              │            │ Refresh fails
              │            ▼
              │     ┌──────────────┐
              │     │    Error     │
              │     └──────┬───────┘
              │            │ User clicks retry
              └────────────┘
```

### Auth Method Switching

```
API Key Active                    ChatGPT OAuth Active
     │                                  │
     │ User completes OAuth ───────────▶│
     │◀─────────── User saves API key ──│
     │◀─────────── User disconnects ────│
```

When switching:
1. New method's credentials are stored
2. Old method's credentials are cleared (OAuth tokens or API key deactivated)
3. `authMethod` field is updated
4. `ModelClientFactory` client cache is invalidated

## Relationships

```
IStoredProviderConfig (modified)
├── id: string
├── apiKey: string
├── organization?: string
└── authMethod?: 'api_key' | 'chatgpt_oauth'  ← NEW
         │
         │ determines which credential source
         ▼
ModelClientFactory.loadConfigForProvider()
├── authMethod === 'chatgpt_oauth' → ChatGPTOAuthService.getValidAccessToken()
└── authMethod === 'api_key' (or undefined) → AgentConfig.getProviderApiKey()
         │
         │ provides apiKey parameter
         ▼
OpenAIResponsesClient / OpenAIChatCompletionClient
└── Authorization: Bearer <token>  (same header regardless of source)
```
