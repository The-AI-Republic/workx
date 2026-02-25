/**
 * Encryption utilities for API keys
 * Used by AgentConfig and Settings for secure storage
 */

/**
 * Encrypt an API key for storage
 * @param plainText - Unencrypted API key
 * @returns Base64-encoded encrypted string
 * @deprecated Use VaultManager.encryptCredential() instead. This function uses
 * simple obfuscation (reverse + base64) and is NOT cryptographically secure.
 * Kept only for legacy migration detection in VaultManager.migrateIfNeeded().
 */
export function encryptApiKey(plainText: string): string {
  // Simple obfuscation: reverse string and base64 encode
  const reversed = plainText.split('').reverse().join('');
  return btoa(reversed);
}

/**
 * Decrypt an encrypted API key
 * @param encrypted - Base64-encoded encrypted string
 * @returns Decrypted plain text, or null if decryption fails
 * @deprecated Use VaultManager.decryptCredential() instead. Kept only for
 * legacy migration detection in VaultManager.migrateIfNeeded().
 */
export function decryptApiKey(encrypted: string): string | null {
  try {
    if (!encrypted) {
      return null;
    }
    const decoded = atob(encrypted);
    // Reverse the string back
    return decoded.split('').reverse().join('');
  } catch (error) {
    console.error('Failed to decrypt API key:', error);
    return null;
  }
}
