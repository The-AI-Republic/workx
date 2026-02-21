/**
 * Keytar Credential Store
 *
 * Desktop-mode implementation of CredentialStore using the OS keychain.
 * Uses Tauri commands that wrap keytar (or native keychain APIs) on the Rust side.
 *
 * Platform-specific storage:
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: libsecret (GNOME Keyring / KWallet)
 *
 * @module desktop/storage/KeytarCredentialStore
 */

import { invoke } from '@tauri-apps/api/core';
import type { CredentialStore } from '@/core/storage/CredentialStore';

/**
 * Service name prefix for Pi credentials
 */
const SERVICE_PREFIX = 'pi';

/**
 * Format the full service name
 */
function formatService(service: string): string {
  return `${SERVICE_PREFIX}-${service}`;
}

/**
 * KeytarCredentialStore implements CredentialStore using OS keychain
 *
 * @example
 * ```typescript
 * const store = new KeytarCredentialStore();
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
export class KeytarCredentialStore implements CredentialStore {
  /**
   * Get a credential from the OS keychain
   *
   * @param service - Service identifier (e.g., 'openai', 'anthropic')
   * @param account - Account identifier (e.g., 'default', 'user@example.com')
   * @returns The credential value or null if not found
   */
  async get(service: string, account: string): Promise<string | null> {
    try {
      const result = await invoke<string | null>('keychain_get', {
        service: formatService(service),
        account,
      });
      return result;
    } catch (error) {
      console.error(`[KeytarCredentialStore] Failed to get ${service}/${account}:`, error);
      return null;
    }
  }

  /**
   * Set a credential in the OS keychain
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @param password - Credential value to store
   */
  async set(service: string, account: string, password: string): Promise<void> {
    try {
      await invoke('keychain_set', {
        service: formatService(service),
        account,
        password,
      });
    } catch (error) {
      console.error(`[KeytarCredentialStore] Failed to set ${service}/${account}:`, error);
      throw new Error(`Failed to store credential: ${error}`);
    }
  }

  /**
   * Delete a credential from the OS keychain
   *
   * @param service - Service identifier
   * @param account - Account identifier
   */
  async delete(service: string, account: string): Promise<void> {
    try {
      await invoke('keychain_delete', {
        service: formatService(service),
        account,
      });
    } catch (error) {
      console.error(`[KeytarCredentialStore] Failed to delete ${service}/${account}:`, error);
      throw new Error(`Failed to delete credential: ${error}`);
    }
  }

  /**
   * List all accounts for a service
   *
   * Note: This operation may not be supported on all platforms.
   * Falls back to reading from a metadata store if native listing is unavailable.
   *
   * @param service - Service identifier
   * @returns Array of account identifiers for the service
   */
  async listAccounts(service: string): Promise<string[]> {
    try {
      // Try native listing first
      const accounts = await invoke<string[]>('keychain_list_accounts', {
        service: formatService(service),
      });
      return accounts || [];
    } catch (error) {
      // Native listing not supported, fall back to metadata lookup
      console.warn('[KeytarCredentialStore] Native account listing not supported:', error);

      try {
        // Fall back to metadata store
        const metadata = await invoke<string[]>('storage_get_credential_accounts', {
          service,
        });
        return metadata || [];
      } catch (metaError) {
        console.warn('[KeytarCredentialStore] Failed to list accounts:', metaError);
        return [];
      }
    }
  }

  /**
   * Check if a credential exists
   *
   * @param service - Service identifier
   * @param account - Account identifier
   * @returns true if the credential exists
   */
  async exists(service: string, account: string): Promise<boolean> {
    const credential = await this.get(service, account);
    return credential !== null;
  }

  /**
   * Get all credentials for a service
   *
   * @param service - Service identifier
   * @returns Map of account to credential value
   */
  async getAllForService(service: string): Promise<Map<string, string>> {
    const accounts = await this.listAccounts(service);
    const results = new Map<string, string>();

    for (const account of accounts) {
      const credential = await this.get(service, account);
      if (credential) {
        results.set(account, credential);
      }
    }

    return results;
  }

  /**
   * Delete all credentials for a service
   *
   * @param service - Service identifier
   */
  async deleteAllForService(service: string): Promise<void> {
    const accounts = await this.listAccounts(service);

    for (const account of accounts) {
      try {
        await this.delete(service, account);
      } catch (error) {
        console.warn(`[KeytarCredentialStore] Failed to delete ${service}/${account}:`, error);
      }
    }
  }
}
