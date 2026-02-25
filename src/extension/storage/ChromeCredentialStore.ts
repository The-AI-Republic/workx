/**
 * Chrome Credential Store
 *
 * Extension-mode implementation of CredentialStore using chrome.storage.local.
 * Credentials are stored encrypted by Chrome's extension storage system.
 *
 * @module extension/storage/ChromeCredentialStore
 */

import type { CredentialStore } from '@/core/storage/CredentialStore';
import * as VaultManager from '@/core/crypto/VaultManager';
import type { EncryptedCredential } from '@/core/crypto/types';

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
    const storageKey = makeKey(service, account);

    const rawValue = await new Promise<unknown>((resolve, reject) => {
      chrome.storage.local.get(storageKey, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Failed to get credential: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve(result[storageKey] ?? null);
      });
    });

    if (rawValue === null || rawValue === undefined) return null;

    // Check if it's an encrypted credential (JSON object with version+ciphertext)
    if (typeof rawValue === 'object' && rawValue !== null && 'version' in rawValue && 'ciphertext' in rawValue) {
      try {
        return await VaultManager.decryptCredential(rawValue as EncryptedCredential);
      } catch (err) {
        console.error(`[ChromeCredentialStore] Failed to decrypt credential ${storageKey}:`, err);
        return null;
      }
    }

    // Check if it's a JSON string of an encrypted credential
    if (typeof rawValue === 'string') {
      try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object' && 'version' in parsed && 'ciphertext' in parsed) {
          return await VaultManager.decryptCredential(parsed as EncryptedCredential);
        }
      } catch {
        // Not JSON — fall through to migration
      }
    }

    // Legacy format — migrate
    try {
      const migrated = await VaultManager.migrateIfNeeded(storageKey, rawValue);
      if (migrated) {
        return await VaultManager.decryptCredential(migrated);
      }
    } catch (err) {
      console.error(`[ChromeCredentialStore] Migration failed for ${storageKey}:`, err);
    }

    // Fallback: return as-is (plain string)
    return typeof rawValue === 'string' ? rawValue : null;
  }

  /**
   * Set a credential
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @param password - Credential value to store
   */
  async set(service: string, account: string, password: string): Promise<void> {
    const storageKey = makeKey(service, account);

    // Encrypt the credential before storing
    let valueToStore: unknown;
    try {
      const encrypted = await VaultManager.encryptCredential(password);
      valueToStore = encrypted;
    } catch (err) {
      console.error(`[ChromeCredentialStore] Encryption failed, storing as-is:`, err);
      valueToStore = password;
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [storageKey]: valueToStore }, () => {
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
