/**
 * Chrome Credential Store
 *
 * Extension-mode implementation of CredentialStore using chrome.storage.local.
 * Credentials are stored encrypted by Chrome's extension storage system.
 *
 * @module extension/storage/ChromeCredentialStore
 */

import type { CredentialStore } from '@/core/storage/CredentialStore';

/**
 * Storage key prefix for credentials
 */
const CREDENTIAL_PREFIX = 'browserx-credential:';

/**
 * Creates a storage key from service and account
 */
function makeKey(service: string, account: string): string {
  return `${CREDENTIAL_PREFIX}${service}:${account}`;
}

/**
 * Creates a prefix for listing all accounts of a service
 */
function makeServicePrefix(service: string): string {
  return `${CREDENTIAL_PREFIX}${service}:`;
}

/**
 * Extracts account name from a full storage key
 */
function extractAccount(key: string, servicePrefix: string): string {
  return key.slice(servicePrefix.length);
}

/**
 * ChromeCredentialStore implements CredentialStore using chrome.storage.local
 *
 * @example
 * ```typescript
 * const store = new ChromeCredentialStore();
 *
 * // Store an API key
 * await store.set('openai', 'default', 'sk-...');
 *
 * // Retrieve the API key
 * const key = await store.get('openai', 'default');
 *
 * // List all OpenAI accounts
 * const accounts = await store.listAccounts('openai');
 *
 * // Delete a credential
 * await store.delete('openai', 'default');
 * ```
 */
export class ChromeCredentialStore implements CredentialStore {
  /**
   * Get a credential
   *
   * @param service - Service identifier (e.g., 'openai', 'anthropic')
   * @param account - Account identifier (e.g., 'default', 'user@example.com')
   * @returns The credential value or null if not found
   */
  async get(service: string, account: string): Promise<string | null> {
    const key = makeKey(service, account);

    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to get credential: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve(result[key] ?? null);
      });
    });
  }

  /**
   * Set a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @param password - Credential value to store
   */
  async set(service: string, account: string, password: string): Promise<void> {
    const key = makeKey(service, account);

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: password }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to set credential: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Delete a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   */
  async delete(service: string, account: string): Promise<void> {
    const key = makeKey(service, account);

    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(key, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to delete credential: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * List all accounts for a service
   *
   * @param service - Service identifier
   * @returns Array of account identifiers for the service
   */
  async listAccounts(service: string): Promise<string[]> {
    const servicePrefix = makeServicePrefix(service);

    return new Promise((resolve, reject) => {
      chrome.storage.local.get(null, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to list accounts: ${chrome.runtime.lastError.message}`));
          return;
        }

        const accounts: string[] = [];
        for (const key of Object.keys(result)) {
          if (key.startsWith(servicePrefix)) {
            accounts.push(extractAccount(key, servicePrefix));
          }
        }

        resolve(accounts);
      });
    });
  }
}
