# Data Model: Chrome Extension Credential Security

**Feature**: 034-credential-security
**Date**: 2026-02-24

## Entities

### 1. VaultMetadata

Persistent metadata about the vault state, stored in `chrome.storage.local`.

```typescript
interface VaultMetadata {
  /** Schema version for forward compatibility */
  version: number;               // Current: 1

  /** Whether PIN protection is enabled */
  pinEnabled: boolean;

  /** Wrapped encryption key (base64-encoded AES-KW output) */
  wrappedKey: string;

  /** Salt used for wrapping key derivation (base64, 16 bytes) */
  wrappingSalt: string;

  /** PIN verification hash (base64, only present when pinEnabled=true) */
  pinVerificationHash?: string;

  /** Salt for PIN verification derivation (base64, 16 bytes, only when pinEnabled=true) */
  pinVerificationSalt?: string;

  /** Timestamp of vault initialization (ISO 8601) */
  createdAt: string;

  /** Timestamp of last wrapping change (ISO 8601) */
  updatedAt: string;
}
```

**Storage key**: `browserx-vault-metadata`
**Lifecycle**: Created on first API key save. Updated when PIN is enabled/changed/removed.

### 2. EncryptedCredential

An individual encrypted API key, stored in `chrome.storage.local`.

```typescript
interface EncryptedCredential {
  /** Schema version */
  version: number;               // Current: 1

  /** AES-GCM encrypted ciphertext (base64) */
  ciphertext: string;

  /** Initialization vector used for this encryption (base64, 12 bytes) */
  iv: string;

  /** Salt used for this encryption operation (base64, 16 bytes) */
  salt: string;
}
```

**Storage key**: `browserx-credential:{service}:{account}` (same prefix as current, value format changes from plain string to JSON)
**Lifecycle**: Created when user saves an API key. Updated on re-encryption (PIN change). Deleted when user removes the API key.

### 3. VaultSession (volatile)

Runtime state held in `chrome.storage.session` and/or service worker memory.

```typescript
interface VaultSession {
  /** Raw encryption key bytes (base64, for service worker restart recovery) */
  encryptionKeyRaw: string;

  /** Lockout cooldown expiry timestamp (ISO 8601, if active) */
  lockoutUntil?: string;

  /** Count of consecutive failed PIN attempts */
  failedAttempts: number;
}
```

**Storage key**: `browserx-vault-session`
**Lifecycle**: Created when vault is unlocked. Cleared automatically by `chrome.storage.session` on browser close or extension reload.

### 4. VaultState (in-memory, UI)

Svelte store state for frontend components.

```typescript
interface VaultState {
  /** Whether the vault system is initialized */
  isInitialized: boolean;

  /** Whether PIN protection is enabled */
  isPinEnabled: boolean;

  /** Whether the vault is currently locked (PIN enabled + no active session) */
  isLocked: boolean;

  /** Whether a lockout cooldown is active */
  isLockedOut: boolean;

  /** Seconds remaining on lockout cooldown */
  lockoutSecondsRemaining: number;
}
```

**Storage**: Svelte writable store (in-memory only)
**Lifecycle**: Initialized on App.svelte mount. Updated via message passing from service worker.

## State Transitions

### Vault Lifecycle

```
                    ┌──────────────┐
                    │ UNINITIALIZED │
                    └──────┬───────┘
                           │ First API key save
                           ▼
                    ┌──────────────┐
              ┌─────│   DEFAULT    │─────┐
              │     │ (build-time  │     │
              │     │  secret)     │     │
              │     └──────────────┘     │
              │            │             │
    User enables PIN       │    User saves/reads API key
              │            │    (transparent, no prompt)
              ▼            │
       ┌─────────────┐    │
       │ PIN_ENABLED  │◄───┘
       │  UNLOCKED    │
       └──────┬───────┘
              │
     Browser close / extension reload
              │
              ▼
       ┌─────────────┐
       │ PIN_ENABLED  │
       │   LOCKED     │
       └──────┬───────┘
              │
     User enters correct PIN
              │
              ▼
       ┌─────────────┐
       │ PIN_ENABLED  │
       │  UNLOCKED    │◄─── (loop)
       └─────────────┘
```

### PIN Operations

```
DEFAULT ──[Enable PIN]──► PIN_ENABLED (re-wrap key with PIN)
PIN_ENABLED ──[Change PIN]──► PIN_ENABLED (unwrap with old, re-wrap with new)
PIN_ENABLED ──[Remove PIN]──► DEFAULT (unwrap with PIN, re-wrap with build-time secret)
PIN_ENABLED ──[Forgot PIN]──► UNINITIALIZED (clear all credentials + metadata, regenerate)
```

### Credential Operations

```
Save API Key:
  1. Vault must be unlocked (or DEFAULT mode)
  2. Generate random IV (12 bytes) + salt (16 bytes)
  3. Encrypt plaintext with encryption key using AES-GCM
  4. Store EncryptedCredential JSON at storage key

Read API Key:
  1. Vault must be unlocked (or DEFAULT mode)
  2. Read EncryptedCredential JSON from storage key
  3. If old format detected (plain string, not JSON): migrate
  4. Decrypt ciphertext with encryption key using AES-GCM
  5. Return plaintext

Delete API Key:
  1. Remove storage key (no unlock required)
```

## Migration Rules

### v0 → v1 (legacy obfuscation → encrypted)

**Detection**: Credential value is a plain string (not JSON with `version` field)

**Migration**:
1. Read raw value from storage
2. Attempt `atob()` + reverse (old decryption)
3. If successful, re-encrypt with VaultCrypto
4. Write back as `EncryptedCredential` JSON
5. If old decryption fails, treat as plain text and encrypt directly

**Trigger**: Lazy, on first read of each credential after upgrade

## Storage Key Map

| Key | Type | Persistence | Description |
| --- | ---- | ----------- | ----------- |
| `browserx-vault-metadata` | VaultMetadata | `chrome.storage.local` | Vault config + wrapped key |
| `browserx-credential:{service}:{account}` | EncryptedCredential | `chrome.storage.local` | Individual encrypted API keys |
| `browserx-vault-session` | VaultSession | `chrome.storage.session` | Volatile session (unwrapped key + lockout) |
