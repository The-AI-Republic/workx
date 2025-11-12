/**
 * Encryption utilities for API keys
 * Used by AgentConfig and Settings for secure storage
 */

/**
 * Encrypt an API key for storage
 * @param plainText - Unencrypted API key
 * @returns Base64-encoded encrypted string
 * @remarks Uses simple obfuscation (not cryptographically secure)
 * @remarks Future versions may upgrade to Web Crypto API
 * @example
 * const encrypted = encryptApiKey('sk-ant-api03-...');
 * // Returns: "Li4uODBpcGEtdG5hLWtz"
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
 * @remarks Returns null on invalid input rather than throwing
 * @example
 * const decrypted = decryptApiKey(encrypted);
 * if (decrypted) {
 *   // Use decrypted API key
 *   makeApiCall(decrypted);
 * } else {
 *   // Decryption failed, key may be corrupted
 *   console.error('Failed to decrypt API key');
 * }
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
