# Vault API Contracts

**Feature**: 034-credential-security
**Date**: 2026-02-24

This feature has no external HTTP APIs. All operations are internal to the Chrome extension via message passing between the frontend (sidepanel/popup) and the background service worker.

## Message Types

Added to existing `MessageRouter.ts` enum:

```typescript
enum MessageType {
  // ... existing types ...

  // Vault operations
  VAULT_STATUS       = 'vault:status',
  VAULT_UNLOCK       = 'vault:unlock',
  VAULT_LOCK         = 'vault:lock',

  // PIN operations
  PIN_SET            = 'vault:pin:set',
  PIN_CHANGE         = 'vault:pin:change',
  PIN_REMOVE         = 'vault:pin:remove',
  PIN_FORGOT         = 'vault:pin:forgot',
}
```

## Message Contracts

### VAULT_STATUS

Get current vault state. Called on App.svelte mount and after any vault operation.

**Request**: `{ type: 'vault:status' }`

**Response**:
```typescript
{
  success: true;
  data: {
    isInitialized: boolean;    // Whether vault has been set up
    isPinEnabled: boolean;     // Whether PIN protection is active
    isLocked: boolean;         // Whether vault needs PIN to unlock
    isLockedOut: boolean;      // Whether lockout cooldown is active
    lockoutSecondsRemaining: number;  // 0 if not locked out
  }
}
```

### VAULT_UNLOCK

Unlock the vault with PIN. Only applicable when `isPinEnabled && isLocked`.

**Request**:
```typescript
{
  type: 'vault:unlock';
  payload: {
    pin: string;     // 6-digit numeric PIN
  }
}
```

**Response (success)**:
```typescript
{
  success: true;
  data: {
    isLocked: false;
  }
}
```

**Response (wrong PIN)**:
```typescript
{
  success: false;
  error: 'incorrect_pin';
  data: {
    attemptsRemaining: number;   // e.g., 3
    isLockedOut: false;
  }
}
```

**Response (locked out)**:
```typescript
{
  success: false;
  error: 'locked_out';
  data: {
    isLockedOut: true;
    lockoutSecondsRemaining: number;  // e.g., 28
  }
}
```

### VAULT_LOCK

Manually lock the vault (clear session). Mainly for testing.

**Request**: `{ type: 'vault:lock' }`

**Response**: `{ success: true }`

### PIN_SET

Enable PIN protection. Vault must be in DEFAULT mode (no PIN currently set).

**Request**:
```typescript
{
  type: 'vault:pin:set';
  payload: {
    pin: string;              // 6-digit numeric PIN
    pinConfirm: string;       // Must match pin
  }
}
```

**Response (success)**:
```typescript
{
  success: true;
  data: {
    isPinEnabled: true;
    isLocked: false;          // Session is active after setting PIN
  }
}
```

**Response (validation error)**:
```typescript
{
  success: false;
  error: 'validation_error';
  message: string;            // e.g., "PIN must be exactly 6 digits"
}
```

### PIN_CHANGE

Change existing PIN. Vault must be PIN-enabled and unlocked.

**Request**:
```typescript
{
  type: 'vault:pin:change';
  payload: {
    currentPin: string;       // Current 6-digit PIN
    newPin: string;           // New 6-digit PIN
    newPinConfirm: string;    // Must match newPin
  }
}
```

**Response (success)**:
```typescript
{
  success: true;
  data: {
    isPinEnabled: true;
    isLocked: false;
  }
}
```

**Response (wrong current PIN)**:
```typescript
{
  success: false;
  error: 'incorrect_pin';
  message: 'Current PIN is incorrect';
}
```

### PIN_REMOVE

Remove PIN protection. Reverts to build-time secret wrapping.

**Request**:
```typescript
{
  type: 'vault:pin:remove';
  payload: {
    pin: string;              // Current PIN for verification
  }
}
```

**Response (success)**:
```typescript
{
  success: true;
  data: {
    isPinEnabled: false;
    isLocked: false;
  }
}
```

### PIN_FORGOT

Reset vault — clears all stored credentials and vault metadata. Generates fresh encryption key wrapped with build-time secret.

**Request**:
```typescript
{
  type: 'vault:pin:forgot';
  payload: {
    confirmReset: true;       // Explicit confirmation required
  }
}
```

**Response (success)**:
```typescript
{
  success: true;
  data: {
    isPinEnabled: false;
    isLocked: false;
    credentialsCleared: true;
  }
}
```

## VaultCrypto Module Contract

Internal TypeScript API (not message-based):

```typescript
interface IVaultCrypto {
  /** Generate a new AES-256-GCM encryption key */
  generateEncryptionKey(): Promise<CryptoKey>;

  /** Derive a wrapping key from a secret string (build-time or PIN) + salt */
  deriveWrappingKey(secret: string, salt: Uint8Array): Promise<CryptoKey>;

  /** Wrap (encrypt) an encryption key with a wrapping key */
  wrapKey(encryptionKey: CryptoKey, wrappingKey: CryptoKey): Promise<ArrayBuffer>;

  /** Unwrap (decrypt) an encryption key with a wrapping key */
  unwrapKey(wrappedKey: ArrayBuffer, wrappingKey: CryptoKey): Promise<CryptoKey>;

  /** Encrypt plaintext with the encryption key */
  encrypt(plaintext: string, encryptionKey: CryptoKey): Promise<EncryptedCredential>;

  /** Decrypt an EncryptedCredential with the encryption key */
  decrypt(credential: EncryptedCredential, encryptionKey: CryptoKey): Promise<string>;

  /** Derive a verification hash from PIN + salt (separate from wrapping derivation) */
  deriveVerificationHash(pin: string, salt: Uint8Array): Promise<string>;

  /** Generate cryptographically random bytes */
  generateSalt(length?: number): Uint8Array;

  /** Generate random IV for AES-GCM (12 bytes) */
  generateIV(): Uint8Array;

  /** Export CryptoKey to raw bytes for session storage */
  exportKey(key: CryptoKey): Promise<ArrayBuffer>;

  /** Import raw bytes back to CryptoKey */
  importKey(raw: ArrayBuffer): Promise<CryptoKey>;
}
```

## VaultManager Contract

High-level vault operations:

```typescript
interface IVaultManager {
  /** Initialize vault on extension startup */
  initialize(): Promise<VaultState>;

  /** Check if vault is initialized (has metadata) */
  isInitialized(): Promise<boolean>;

  /** Get current vault state */
  getStatus(): Promise<VaultState>;

  /** Unlock vault with PIN */
  unlock(pin: string): Promise<VaultUnlockResult>;

  /** Lock vault (clear session) */
  lock(): Promise<void>;

  /** Enable PIN protection */
  enablePin(pin: string): Promise<void>;

  /** Change PIN */
  changePin(currentPin: string, newPin: string): Promise<void>;

  /** Remove PIN protection */
  removePin(pin: string): Promise<void>;

  /** Reset vault (forgot PIN) */
  reset(): Promise<void>;

  /** Get the active encryption key (unwrapped). Throws if locked. */
  getEncryptionKey(): Promise<CryptoKey>;

  /** Encrypt a credential value */
  encryptCredential(plaintext: string): Promise<EncryptedCredential>;

  /** Decrypt a credential value */
  decryptCredential(credential: EncryptedCredential): Promise<string>;

  /** Detect and migrate a legacy credential */
  migrateIfNeeded(storageKey: string, rawValue: unknown): Promise<EncryptedCredential | null>;
}
```
