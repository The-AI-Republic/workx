/**
 * Vault type definitions for credential security
 *
 * @module core/crypto/types
 */

/** Persistent vault metadata stored in chrome.storage.local */
export interface VaultMetadata {
  /** Schema version for forward compatibility */
  version: number;
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

/** Individual encrypted API key stored in chrome.storage.local */
export interface EncryptedCredential {
  /** Schema version */
  version: number;
  /** AES-GCM encrypted ciphertext (base64) */
  ciphertext: string;
  /** Initialization vector used for this encryption (base64, 12 bytes) */
  iv: string;
  /** Salt used for this encryption operation (base64, 16 bytes) */
  salt: string;
}

/** Volatile session state held in chrome.storage.session */
export interface VaultSession {
  /** Raw encryption key bytes (base64, for service worker restart recovery) */
  encryptionKeyRaw: string;
  /** Lockout cooldown expiry timestamp (ISO 8601, if active) */
  lockoutUntil?: string;
  /** Count of consecutive failed PIN attempts */
  failedAttempts: number;
}

/** Svelte store state for frontend components */
export interface VaultState {
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

/** Result of a vault unlock attempt */
export interface VaultUnlockResult {
  success: boolean;
  error?: 'incorrect_pin' | 'locked_out';
  attemptsRemaining?: number;
  isLockedOut?: boolean;
  lockoutSecondsRemaining?: number;
}

/** Storage keys for vault data */
export const VAULT_STORAGE_KEYS = {
  METADATA: 'browserx-vault-metadata',
  SESSION: 'browserx-vault-session',
} as const;

/** Current vault metadata schema version */
export const VAULT_VERSION = 1;

/** Current encrypted credential schema version */
export const CREDENTIAL_VERSION = 1;

/** PBKDF2 iterations for key derivation */
export const PBKDF2_ITERATIONS = 100_000;

/** Maximum consecutive failed PIN attempts before lockout */
export const MAX_FAILED_ATTEMPTS = 5;

/** Lockout duration in milliseconds (30 seconds) */
export const LOCKOUT_DURATION_MS = 30_000;
