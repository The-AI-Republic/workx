/**
 * Vault store — tracks vault locked/unlocked state for UI
 *
 * @module webfront/stores/vaultStore
 */

import { writable } from 'svelte/store';
import type { VaultState } from '@/core/crypto/types';

const defaultState: VaultState = {
  isInitialized: false,
  isPinEnabled: false,
  isLocked: false,
  isLockedOut: false,
  lockoutSecondsRemaining: 0,
};

export const vaultStore = writable<VaultState>(defaultState);

/**
 * Refresh vault status from the service worker.
 * Sends VAULT_STATUS message and updates the store with the response.
 */
export async function refreshVaultStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'vault:status' });
    if (response?.success && response.data) {
      vaultStore.set(response.data);
    }
  } catch (err) {
    console.warn('[vaultStore] Failed to refresh vault status:', err);
  }
}
