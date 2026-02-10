# Desktop Authentication Design Document

**Version**: 1.0
**Date**: 2026-02-05
**Status**: Implemented
**Related**: [Desktop App Design](./desktop_app_design.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication Flow](#2-authentication-flow)
3. [URL Scheme](#3-url-scheme)
4. [Backend Changes](#4-backend-changes)
5. [Frontend Changes](#5-frontend-changes)
6. [Security Considerations](#6-security-considerations)
7. [Token Management](#7-token-management)

---

## 1. Overview

### 1.1 Background

Pi desktop app needs to support the same dual authentication model as the BrowserX Chrome extension:

1. **API Key Mode**: Users provide their own LLM provider API keys (stored in OS keychain)
2. **AI Republic Login Mode**: Users login via AI Republic to route requests through the backend

The Chrome extension uses cookies for session management, but desktop apps cannot use browser cookies. This document describes the deep link-based OAuth flow for desktop authentication.

### 1.2 Goals

| ID | Goal | Status |
|----|------|--------|
| G1 | Support OAuth login via browser | ✅ Implemented |
| G2 | Store tokens securely in OS keychain | ✅ Implemented |
| G3 | Support token refresh without re-login | ✅ Implemented |
| G4 | No localhost server required | ✅ Implemented |

---

## 2. Authentication Flow

### 2.1 Login Flow Diagram

```
┌─────────────────┐                              ┌───────────────────────┐
│   Pi Desktop    │   1. User clicks "Login"     │   AI Republic Web     │
│                 │ ─────────────────────────►   │   (HOME_BASE_URL)     │
│                 │   Opens browser to:          │                       │
│                 │   /auth/login/google?        │   /auth/login/google  │
│                 │   redirect_url=              │                       │
│                 │   airepublic-pi://...        │                       │
│                 │                              └───────────┬───────────┘
│                 │                                          │
│                 │                              2. Google OAuth
│                 │                                          │
│                 │                              ┌───────────▼───────────┐
│                 │                              │   Google OAuth        │
│                 │                              │   Consent Screen      │
│                 │                              └───────────┬───────────┘
│                 │                                          │
│                 │                              3. OAuth callback
│                 │                                          │
│                 │                              ┌───────────▼───────────┐
│                 │   4. Redirect to deep link   │   /auth/google/       │
│                 │ ◄─────────────────────────── │   callback            │
│                 │   airepublic-pi://auth/      │                       │
│                 │   callback?access_token=...  │   Issues JWT tokens   │
│                 │   &refresh_token=...         │                       │
│                 │                              └───────────────────────┘
│                 │
│  5. OS routes   │
│  deep link to   │
│  Pi app         │
│                 │
│  6. Parse URL,  │
│  extract tokens │
│                 │
│  7. Store in    │
│  OS Keychain    │
│                 │
│  8. User is     │
│  authenticated  │
└─────────────────┘
```

### 2.2 Token Refresh Flow

```
┌─────────────────┐                              ┌───────────────────────┐
│   Pi Desktop    │   POST /auth/desktop/refresh │   AI Republic API     │
│                 │ ─────────────────────────►   │                       │
│                 │   Body: {refresh_token}      │   Validates token,    │
│                 │                              │   issues new pair     │
│                 │   {access_token,             │                       │
│                 │    refresh_token}            │                       │
│                 │ ◄───────────────────────────┤│                       │
│                 │                              └───────────────────────┘
│  Store new      │
│  tokens in      │
│  keychain       │
└─────────────────┘
```

---

## 3. URL Scheme

### 3.1 Scheme Selection

We chose `airepublic-pi://` as the custom URL scheme because:

| Criteria | `pi://` | `airepublic-pi://` |
|----------|---------|-------------------|
| Uniqueness | Low (conflicts with Raspberry Pi, math apps) | High |
| RFC 3986 Compliant | ✅ | ✅ |
| Brand Recognition | ❌ | ✅ |
| Conflict Risk | High | Very Low |

### 3.2 URL Format

**Auth Callback URL:**
```
airepublic-pi://auth/callback?access_token=<jwt>&refresh_token=<jwt>&token_type=Bearer
```

**Error Callback URL:**
```
airepublic-pi://auth/callback?error=<error_message>
```

### 3.3 Platform Registration

#### macOS
Configured in `tauri.conf.json`:
```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["airepublic-pi"]
      }
    }
  }
}
```

Tauri registers this in the app's `Info.plist` as `CFBundleURLSchemes`.

#### Windows
Tauri registers the scheme in Windows Registry at:
```
HKEY_CLASSES_ROOT\airepublic-pi
```

#### Linux
Tauri creates a `.desktop` file with:
```ini
MimeType=x-scheme-handler/airepublic-pi;
```

---

## 4. Backend Changes

### 4.1 Modified Endpoints

#### `/auth/login/google` (Modified)
- **Change**: Accepts `airepublic-pi://` as valid redirect URL
- **Behavior**: Stores redirect URL in Redis state

#### `/auth/google/callback` (Modified)
- **Change**: Detects desktop redirect URLs
- **Behavior**: For desktop redirects, returns tokens in URL instead of cookies

```python
# Detection logic
ALLOWED_DESKTOP_SCHEMES = ["airepublic-pi://"]

def is_desktop_redirect(redirect_url: Optional[str]) -> bool:
    if not redirect_url:
        return False
    return any(redirect_url.startswith(scheme) for scheme in ALLOWED_DESKTOP_SCHEMES)
```

### 4.2 New Endpoints

#### `POST /auth/desktop/refresh`
Refresh tokens for desktop apps (no cookies).

**Request:**
```json
{
  "refresh_token": "<jwt>"
}
```

**Response:**
```json
{
  "ok": true,
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

#### `GET /auth/desktop/session`
Get user session using Bearer token.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:** UserResponse object

---

## 5. Frontend Changes

### 5.1 Tauri Configuration

**tauri.conf.json:**
```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["airepublic-pi"]
      }
    }
  }
}
```

**Cargo.toml:**
```toml
tauri-plugin-deep-link = "2"
```

### 5.2 Rust Backend (main.rs)

```rust
.plugin(tauri_plugin_deep_link::init())
.setup(|app| {
    let handle = app.handle().clone();
    app.listen("deep-link://new-url", move |event| {
        if let Some(urls) = event.payload().as_str() {
            let _ = handle.emit("auth-callback", urls);
        }
    });
    Ok(())
})
```

### 5.3 TypeScript Service

**Location:** `src/desktop/auth/DesktopAuthService.ts`

**Key Methods:**
- `login()` - Opens browser, waits for callback, stores tokens
- `getSession()` - Fetches user data with access token
- `refreshTokens()` - Refreshes expired tokens
- `logout()` - Clears stored tokens

**Token Storage:**
- Service: `browserx-auth`
- Accounts: `access_token`, `refresh_token`
- Backend: OS Keychain via `KeytarCredentialStore`

---

## 6. Security Considerations

### 6.1 Why Direct Token in URL is Acceptable

For first-party desktop apps with custom URL schemes:

| Concern | Mitigation |
|---------|------------|
| URL logged in browser history | Custom schemes (`airepublic-pi://`) are not logged |
| Token interception | OS routes directly to app, no network traversal |
| Token exposure | First-party app, same trust level as cookies |

### 6.2 Token Security

| Aspect | Implementation |
|--------|----------------|
| Storage | OS Keychain (macOS), Credential Manager (Windows), libsecret (Linux) |
| Access Token TTL | 15-30 minutes |
| Refresh Token TTL | 30 days |
| Token Rotation | New refresh token on each refresh |

### 6.3 Allowed Schemes

Only explicitly allowed schemes can receive tokens:
```python
ALLOWED_DESKTOP_SCHEMES = ["airepublic-pi://"]
```

---

## 7. Token Management

### 7.1 Storage Structure

```
OS Keychain
└── browserx-auth
    ├── access_token: <jwt>
    └── refresh_token: <jwt>
```

### 7.2 Token Lifecycle

```
1. Login
   └── Store access_token + refresh_token

2. API Request
   ├── Get access_token from keychain
   ├── Add Authorization header
   └── If 401:
       ├── Call refreshTokens()
       └── Retry request

3. Token Refresh
   ├── Get refresh_token from keychain
   ├── POST /auth/desktop/refresh
   └── Store new access_token + refresh_token

4. Logout
   └── Delete access_token + refresh_token
```

### 7.3 Auto-Refresh

The `DesktopAuthService` automatically attempts token refresh when:
- `getSession()` returns 401
- Before token expiry (if expires_in is tracked)

---

## Appendix: File Changes

### Backend (home-page)

| File | Change |
|------|--------|
| `backend/apps/auth/router.py` | Added `is_desktop_redirect()`, `build_desktop_redirect_url()`, `/desktop/refresh`, `/desktop/session` |

### Frontend (browserx)

| File | Change |
|------|--------|
| `tauri/tauri.conf.json` | Added deep-link plugin config |
| `tauri/Cargo.toml` | Added `tauri-plugin-deep-link` |
| `tauri/src/main.rs` | Added deep-link plugin init and event listener |
| `src/desktop/auth/DesktopAuthService.ts` | New file - auth service |
| `src/desktop/auth/index.ts` | New file - module exports |
