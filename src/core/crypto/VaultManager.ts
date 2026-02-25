/**
 * VaultManager - High-level vault state management for credential security
 *
 * Manages the vault lifecycle:
 * - Layer 1 (default): Automatic AES-256-GCM encryption with build-time secret wrapping
 * - Layer 2 (opt-in): PIN protection with PBKDF2-derived key wrapping
 *
 * All crypto operations are centralized here (runs in service worker).
 * CryptoKey objects never leave this module.
 *
 * @module core/crypto/VaultManager
 */

import type {
  VaultMetadata,
  VaultSession,
  VaultState,
  EncryptedCredential,
  VaultUnlockResult,
} from './types';
import {
  VAULT_STORAGE_KEYS,
  VAULT_VERSION,
  CREDENTIAL_VERSION,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
} from './types';
import * as VaultCrypto from './VaultCrypto';

// Module-level state (service worker memory)
let encryptionKey: CryptoKey | null = null;
let vaultMetadata: VaultMetadata | null = null;
let initialized = false;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the vault on extension startup.
 * Detects vault state and restores session if available.
 */
export async function initialize(): Promise<VaultState> {
  // Load metadata from persistent storage
  vaultMetadata = await loadMetadata();

  if (vaultMetadata && !vaultMetadata.pinEnabled) {
    // Default mode: unwrap encryption key using build-time secret
    try {
      encryptionKey = await unwrapWithBuildSecret(vaultMetadata);
    } catch (err) {
      console.error('[VaultManager] Failed to unwrap key with build-time secret:', err);
      encryptionKey = null;
    }
  } else if (vaultMetadata && vaultMetadata.pinEnabled) {
    // PIN mode: try to restore from session storage
    encryptionKey = await restoreFromSession();
  }

  initialized = true;
  return getStatus();
}

/**
 * Check if vault has been initialized (has metadata).
 */
export function isInitialized(): boolean {
  return initialized && vaultMetadata !== null;
}

/**
 * Get current vault state for UI.
 */
export function getStatus(): VaultState {
  const locked = vaultMetadata?.pinEnabled === true && encryptionKey === null;

  return {
    isInitialized: vaultMetadata !== null,
    isPinEnabled: vaultMetadata?.pinEnabled ?? false,
    isLocked: locked,
    isLockedOut: false, // Computed on-demand during unlock
    lockoutSecondsRemaining: 0,
  };
}

/**
 * Get the active encryption key (unwrapped). Throws if locked.
 */
export async function getEncryptionKey(): Promise<CryptoKey> {
  if (encryptionKey) {
    return encryptionKey;
  }

  if (!vaultMetadata) {
    // First use: generate new key and wrap with build-time secret
    await initializeNewVault();
    return encryptionKey!;
  }

  if (!vaultMetadata.pinEnabled) {
    // Default mode: unwrap with build-time secret
    encryptionKey = await unwrapWithBuildSecret(vaultMetadata);
    return encryptionKey;
  }

  throw new Error('Vault is locked. Enter PIN to unlock.');
}

// ============================================================================
// Credential Operations
// ============================================================================

/** Encrypt a credential value */
export async function encryptCredential(plaintext: string): Promise<EncryptedCredential> {
  const key = await getEncryptionKey();
  return VaultCrypto.encrypt(plaintext, key);
}

/** Decrypt a credential value */
export async function decryptCredential(credential: EncryptedCredential): Promise<string> {
  if (credential.version > CREDENTIAL_VERSION) {
    throw new Error(
      `Unsupported credential version ${credential.version}. ` +
      `This extension supports up to version ${CREDENTIAL_VERSION}. ` +
      `Please update the extension.`
    );
  }
  const key = await getEncryptionKey();
  return VaultCrypto.decrypt(credential, key);
}

/**
 * Detect and migrate a legacy credential (btoa+reverse format).
 * Returns the new EncryptedCredential, or null if the value is not a legacy format.
 */
export async function migrateIfNeeded(
  storageKey: string,
  rawValue: unknown
): Promise<EncryptedCredential | null> {
  if (typeof rawValue !== 'string') return null;

  // Check if it's already an encrypted credential JSON
  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object' && 'version' in parsed && 'ciphertext' in parsed) {
      return null; // Already migrated
    }
  } catch {
    // Not JSON — might be legacy format
  }

  // Try legacy decryption (btoa + reverse)
  let plaintext: string;
  try {
    const decoded = atob(rawValue);
    plaintext = decoded.split('').reverse().join('');
  } catch {
    // Not valid base64 — treat as raw plaintext
    plaintext = rawValue;
  }

  // Re-encrypt with new vault encryption
  const encrypted = await encryptCredential(plaintext);

  // Write back to storage
  await chromeStorageSet({ [storageKey]: JSON.stringify(encrypted) });

  console.log(`[VaultManager] Migrated legacy credential: ${storageKey}`);
  return encrypted;
}

// ============================================================================
// PIN Operations
// ============================================================================

/** Enable PIN protection */
export async function enablePin(pin: string): Promise<void> {
  if (!vaultMetadata) {
    throw new Error('Vault not initialized');
  }
  if (vaultMetadata.pinEnabled) {
    throw new Error('PIN is already enabled');
  }

  const key = await getEncryptionKey();

  // Generate new salt for PIN-based wrapping
  const wrappingSalt = VaultCrypto.generateSalt();
  const wrappingKey = await VaultCrypto.deriveWrappingKey(pin, wrappingSalt);
  const wrappedKey = await VaultCrypto.wrapKey(key, wrappingKey);

  // Generate verification hash with separate salt
  const verificationSalt = VaultCrypto.generateSalt();
  const verificationHash = await VaultCrypto.deriveVerificationHash(pin, verificationSalt);

  // Update metadata
  vaultMetadata = {
    ...vaultMetadata,
    pinEnabled: true,
    wrappedKey: bufferToBase64(wrappedKey),
    wrappingSalt: bufferToBase64(wrappingSalt),
    pinVerificationHash: verificationHash,
    pinVerificationSalt: bufferToBase64(verificationSalt),
    updatedAt: new Date().toISOString(),
  };

  await saveMetadata(vaultMetadata);

  // Save session so user doesn't need to enter PIN until browser close
  await saveSession(key);
}

/** Change PIN */
export async function changePin(currentPin: string, newPin: string): Promise<void> {
  if (!vaultMetadata?.pinEnabled) {
    throw new Error('PIN is not enabled');
  }

  // Verify current PIN
  const verified = await verifyPin(currentPin);
  if (!verified) {
    throw new Error('Current PIN is incorrect');
  }

  // Get the current encryption key
  const key = await getEncryptionKey();

  // Re-wrap with new PIN
  const wrappingSalt = VaultCrypto.generateSalt();
  const wrappingKey = await VaultCrypto.deriveWrappingKey(newPin, wrappingSalt);
  const wrappedKey = await VaultCrypto.wrapKey(key, wrappingKey);

  // New verification hash
  const verificationSalt = VaultCrypto.generateSalt();
  const verificationHash = await VaultCrypto.deriveVerificationHash(newPin, verificationSalt);

  vaultMetadata = {
    ...vaultMetadata,
    wrappedKey: bufferToBase64(wrappedKey),
    wrappingSalt: bufferToBase64(wrappingSalt),
    pinVerificationHash: verificationHash,
    pinVerificationSalt: bufferToBase64(verificationSalt),
    updatedAt: new Date().toISOString(),
  };

  await saveMetadata(vaultMetadata);
  await saveSession(key);
}

/** Remove PIN protection — reverts to build-time secret wrapping */
export async function removePin(pin: string): Promise<void> {
  if (!vaultMetadata?.pinEnabled) {
    throw new Error('PIN is not enabled');
  }

  const verified = await verifyPin(pin);
  if (!verified) {
    throw new Error('PIN is incorrect');
  }

  const key = await getEncryptionKey();

  // Re-wrap with build-time secret
  const secret = getBuildTimeSecret();
  const wrappingSalt = VaultCrypto.generateSalt();
  const wrappingKey = await VaultCrypto.deriveWrappingKey(secret, wrappingSalt);
  const wrappedKey = await VaultCrypto.wrapKey(key, wrappingKey);

  vaultMetadata = {
    ...vaultMetadata,
    pinEnabled: false,
    wrappedKey: bufferToBase64(wrappedKey),
    wrappingSalt: bufferToBase64(wrappingSalt),
    pinVerificationHash: undefined,
    pinVerificationSalt: undefined,
    updatedAt: new Date().toISOString(),
  };

  await saveMetadata(vaultMetadata);
  await clearSession();
}

// ============================================================================
// Unlock / Lock
// ============================================================================

/** Unlock vault with PIN */
export async function unlock(pin: string): Promise<VaultUnlockResult> {
  if (!vaultMetadata?.pinEnabled) {
    return { success: true };
  }

  // Check lockout
  const session = await loadSession();
  if (session?.lockoutUntil) {
    const lockoutEnd = new Date(session.lockoutUntil).getTime();
    const now = Date.now();
    if (now < lockoutEnd) {
      const remaining = Math.ceil((lockoutEnd - now) / 1000);
      return {
        success: false,
        error: 'locked_out',
        isLockedOut: true,
        lockoutSecondsRemaining: remaining,
      };
    }
  }

  // Verify PIN
  const verified = await verifyPin(pin);
  if (!verified) {
    const failedAttempts = (session?.failedAttempts ?? 0) + 1;
    const attemptsRemaining = MAX_FAILED_ATTEMPTS - failedAttempts;

    const updatedSession: Partial<VaultSession> = { failedAttempts };

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      updatedSession.lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      updatedSession.failedAttempts = 0; // Reset after lockout
    }

    await updateSessionFields(updatedSession);

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      return {
        success: false,
        error: 'locked_out',
        isLockedOut: true,
        lockoutSecondsRemaining: Math.ceil(LOCKOUT_DURATION_MS / 1000),
      };
    }

    return {
      success: false,
      error: 'incorrect_pin',
      attemptsRemaining: Math.max(0, attemptsRemaining),
      isLockedOut: false,
    };
  }

  // PIN correct — unwrap key
  try {
    const wrappingSalt = base64ToBuffer(vaultMetadata.wrappingSalt);
    const wrappingKey = await VaultCrypto.deriveWrappingKey(pin, wrappingSalt);
    const wrappedKey = base64ToBuffer(vaultMetadata.wrappedKey);
    encryptionKey = await VaultCrypto.unwrapKey(wrappedKey, wrappingKey);

    // Save session and reset attempts
    await saveSession(encryptionKey);
    return { success: true };
  } catch (err) {
    console.error('[VaultManager] Failed to unwrap key after PIN verification:', err);
    return {
      success: false,
      error: 'incorrect_pin',
      attemptsRemaining: 0,
      isLockedOut: false,
    };
  }
}

/** Lock vault (clear session) */
export async function lock(): Promise<void> {
  encryptionKey = null;
  await clearSession();
}

/** Reset vault — clears all credentials and metadata (forgot PIN) */
export async function reset(): Promise<void> {
  // Clear all browserx-credential:* keys
  const allKeys = await chromeStorageGetAll();
  const credentialKeys = Object.keys(allKeys).filter(k => k.startsWith('browserx-credential:'));
  if (credentialKeys.length > 0) {
    await chromeStorageRemove(credentialKeys);
  }

  // Clear vault metadata
  await chromeStorageRemove([VAULT_STORAGE_KEYS.METADATA]);
  await clearSession();

  // Re-initialize fresh vault
  encryptionKey = null;
  vaultMetadata = null;
  await initializeNewVault();
}

// ============================================================================
// Private Helpers
// ============================================================================

function getBuildTimeSecret(): string {
  const secret = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_VAULT_SECRET) || '';
  if (!secret) {
    throw new Error('VITE_VAULT_SECRET is not configured');
  }
  return secret;
}

async function initializeNewVault(): Promise<void> {
  const key = await VaultCrypto.generateEncryptionKey();
  const secret = getBuildTimeSecret();
  const wrappingSalt = VaultCrypto.generateSalt();
  const wrappingKey = await VaultCrypto.deriveWrappingKey(secret, wrappingSalt);
  const wrappedKey = await VaultCrypto.wrapKey(key, wrappingKey);

  const now = new Date().toISOString();
  vaultMetadata = {
    version: VAULT_VERSION,
    pinEnabled: false,
    wrappedKey: bufferToBase64(wrappedKey),
    wrappingSalt: bufferToBase64(wrappingSalt),
    createdAt: now,
    updatedAt: now,
  };

  await saveMetadata(vaultMetadata);
  encryptionKey = key;
}

async function unwrapWithBuildSecret(metadata: VaultMetadata): Promise<CryptoKey> {
  const secret = getBuildTimeSecret();
  const wrappingSalt = base64ToBuffer(metadata.wrappingSalt);
  const wrappingKey = await VaultCrypto.deriveWrappingKey(secret, wrappingSalt);
  const wrappedKey = base64ToBuffer(metadata.wrappedKey);
  return VaultCrypto.unwrapKey(wrappedKey, wrappingKey);
}

async function verifyPin(pin: string): Promise<boolean> {
  if (!vaultMetadata?.pinVerificationHash || !vaultMetadata?.pinVerificationSalt) {
    return false;
  }
  const salt = base64ToBuffer(vaultMetadata.pinVerificationSalt);
  const hash = await VaultCrypto.deriveVerificationHash(pin, salt);
  return hash === vaultMetadata.pinVerificationHash;
}

// ============================================================================
// Session Storage (chrome.storage.session)
// ============================================================================

async function saveSession(key: CryptoKey): Promise<void> {
  const raw = await VaultCrypto.exportKey(key);
  const session: VaultSession = {
    encryptionKeyRaw: bufferToBase64(raw),
    failedAttempts: 0,
  };
  await chromeSessionSet({ [VAULT_STORAGE_KEYS.SESSION]: session });
}

async function loadSession(): Promise<VaultSession | null> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) {
      resolve(null);
      return;
    }
    chrome.storage.session.get(VAULT_STORAGE_KEYS.SESSION, (result) => {
      resolve(result[VAULT_STORAGE_KEYS.SESSION] ?? null);
    });
  });
}

async function restoreFromSession(): Promise<CryptoKey | null> {
  const session = await loadSession();
  if (!session?.encryptionKeyRaw) return null;

  try {
    const raw = base64ToBuffer(session.encryptionKeyRaw);
    return await VaultCrypto.importKey(raw);
  } catch (err) {
    console.warn('[VaultManager] Failed to restore key from session:', err);
    return null;
  }
}

async function updateSessionFields(fields: Partial<VaultSession>): Promise<void> {
  const session = await loadSession();
  const updated = { ...session, ...fields } as VaultSession;
  await chromeSessionSet({ [VAULT_STORAGE_KEYS.SESSION]: updated });
}

async function clearSession(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  return new Promise((resolve) => {
    chrome.storage.session.remove(VAULT_STORAGE_KEYS.SESSION, () => resolve());
  });
}

// ============================================================================
// Chrome Storage Helpers
// ============================================================================

async function loadMetadata(): Promise<VaultMetadata | null> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(VAULT_STORAGE_KEYS.METADATA, (result) => {
      resolve(result[VAULT_STORAGE_KEYS.METADATA] ?? null);
    });
  });
}

async function saveMetadata(metadata: VaultMetadata): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [VAULT_STORAGE_KEYS.METADATA]: metadata }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Failed to save vault metadata: ${chrome.runtime.lastError.message}`));
      } else {
        resolve();
      }
    });
  });
}

async function chromeStorageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function chromeStorageGetAll(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (result) => resolve(result));
  });
}

async function chromeStorageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

async function chromeSessionSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) {
      resolve();
      return;
    }
    chrome.storage.session.set(items, () => resolve());
  });
}

// ============================================================================
// Base64 Helpers
// ============================================================================

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
