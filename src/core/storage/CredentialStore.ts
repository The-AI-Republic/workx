/**
 * Credential Store Interface
 *
 * Secure storage for sensitive credentials.
 * Uses chrome.storage.local (extension) or OS keychain (desktop).
 *
 * @module core/storage/CredentialStore
 */

/**
 * Credential Store Interface
 *
 * @example Extension Mode
 * ```typescript
 * const store = new ChromeCredentialStore();
 * await store.set('openai', 'default', 'sk-...');
 * const key = await store.get('openai', 'default');
 * ```
 *
 * @example Desktop Mode
 * ```typescript
 * const store = new KeytarCredentialStore();
 * await store.set('openai', 'default', 'sk-...');
 * // Stored in OS keychain (Keychain on macOS, Credential Manager on Windows)
 * ```
 */
export interface CredentialStore {
  /**
   * Get a credential
   *
   * @param service - Service identifier (e.g., 'openai', 'anthropic')
   * @param account - Account identifier (e.g., 'default', 'user@example.com')
   * @returns The credential value or null
   */
  get(service: string, account: string): Promise<string | null>;

  /**
   * Set a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @param password - Credential value
   */
  set(service: string, account: string, password: string): Promise<void>;

  /**
   * Delete a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   */
  delete(service: string, account: string): Promise<void>;

  /**
   * List all accounts for a service
   *
   * @param service - Service identifier
   * @returns Array of account identifiers
   */
  listAccounts(service: string): Promise<string[]>;
}

// ============================================================================
// Singleton Management
// ============================================================================

let credentialStoreInstance: CredentialStore | null = null;

/**
 * Get the global CredentialStore instance
 * @throws Error if not initialized
 */
export function getCredentialStore(): CredentialStore {
  if (!credentialStoreInstance) {
    throw new Error('CredentialStore not initialized. Call initializeCredentialStore() first.');
  }
  return credentialStoreInstance;
}

/**
 * Set the global CredentialStore instance
 */
export function setCredentialStore(store: CredentialStore): void {
  credentialStoreInstance = store;
}

/**
 * Check if CredentialStore is initialized
 */
export function isCredentialStoreInitialized(): boolean {
  return credentialStoreInstance !== null;
}
