/**
 * VaultCrypto - Low-level cryptographic operations for vault credential encryption
 *
 * Uses Web Crypto API exclusively:
 * - AES-256-GCM for encryption/decryption
 * - PBKDF2 (SHA-256, 100k iterations) for key derivation
 * - AES-KW for key wrapping/unwrapping
 *
 * @module core/crypto/VaultCrypto
 */

import type { EncryptedCredential } from './types';
import { PBKDF2_ITERATIONS, CREDENTIAL_VERSION } from './types';
import { bufferToBase64, base64ToBuffer } from './encoding';

const crypto = globalThis.crypto;

// ============================================================================
// Key Generation
// ============================================================================

/** Generate a new AES-256-GCM encryption key */
export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for wrapKey/exportKey
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive a wrapping key from a secret string (build-time or PIN) + salt
 * Uses PBKDF2 with SHA-256
 */
export async function deriveWrappingKey(
  secret: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

// ============================================================================
// Key Wrapping (AES-KW)
// ============================================================================

/** Wrap (encrypt) an encryption key with a wrapping key */
export async function wrapKey(
  encryptionKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<ArrayBuffer> {
  return crypto.subtle.wrapKey('raw', encryptionKey, wrappingKey, 'AES-KW');
}

/** Unwrap (decrypt) an encryption key with a wrapping key */
export async function unwrapKey(
  wrappedKey: ArrayBuffer | Uint8Array<ArrayBuffer>,
  wrappingKey: CryptoKey
): Promise<CryptoKey> {
  const keyBuffer = wrappedKey instanceof Uint8Array ? wrappedKey.buffer : wrappedKey;
  return crypto.subtle.unwrapKey(
    'raw',
    keyBuffer,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

// ============================================================================
// Encrypt / Decrypt (AES-GCM)
// ============================================================================

/** Encrypt plaintext with the encryption key */
export async function encrypt(
  plaintext: string,
  encryptionKey: CryptoKey
): Promise<EncryptedCredential> {
  const encoder = new TextEncoder();
  const iv = generateIV();

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    encoder.encode(plaintext)
  );

  return {
    version: CREDENTIAL_VERSION,
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
  };
}

/** Decrypt an EncryptedCredential with the encryption key */
export async function decrypt(
  credential: EncryptedCredential,
  encryptionKey: CryptoKey
): Promise<string> {
  const decoder = new TextDecoder();
  const iv = base64ToBuffer(credential.iv);
  const ciphertextBuffer = base64ToBuffer(credential.ciphertext);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    ciphertextBuffer
  );

  return decoder.decode(plaintextBuffer);
}

// ============================================================================
// PIN Verification Hash
// ============================================================================

/**
 * Derive a verification hash from PIN + salt (separate from wrapping derivation).
 * Returns base64-encoded hash.
 */
export async function deriveVerificationHash(
  pin: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return bufferToBase64(bits);
}

// ============================================================================
// Random Data Generation
// ============================================================================

/** Generate cryptographically random bytes (default 16 bytes for salt) */
export function generateSalt(length = 16): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

/** Generate random IV for AES-GCM (12 bytes) */
export function generateIV(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
}

// ============================================================================
// Key Export / Import
// ============================================================================

/** Export CryptoKey to raw bytes for session storage */
export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key);
}

/** Import raw bytes back to CryptoKey */
export async function importKey(raw: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const keyBuffer = raw instanceof Uint8Array ? raw.buffer : raw;
  return crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Re-export encoding utilities for external consumers
export { bufferToBase64, base64ToBuffer } from './encoding';
