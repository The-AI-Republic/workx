/**
 * Vault Service Handlers
 *
 * Platform-agnostic service handlers for vault/PIN management.
 * Extracted from extension service-worker setupVaultMessageHandlers().
 *
 * @module core/services/vault-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface VaultServiceDeps {
  vaultManager: {
    getStatus(): unknown;
    unlock(pin: string): Promise<{ success: boolean; error?: string; lockoutSecondsRemaining?: number }>;
    lock(): Promise<void>;
    enablePin(pin: string): Promise<void>;
    changePin(currentPin: string, newPin: string): Promise<void>;
    removePin(pin: string): Promise<void>;
    reset(): Promise<void>;
  };
}

export function createVaultServices(deps: VaultServiceDeps): Record<string, ServiceHandler> {
  const { vaultManager } = deps;

  return {
    'vault.status': async () => {
      return vaultManager.getStatus();
    },

    'vault.unlock': async (params) => {
      const { pin } = params as { pin?: string };
      if (!pin || typeof pin !== 'string') {
        throw new Error('PIN is required');
      }
      return await vaultManager.unlock(pin);
    },

    'vault.lock': async () => {
      await vaultManager.lock();
      return { success: true };
    },

    'vault.pin.set': async (params) => {
      const { pin, pinConfirm } = params as { pin?: string; pinConfirm?: string };
      if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        throw new Error('PIN must be exactly 6 digits');
      }
      if (pin !== pinConfirm) {
        throw new Error('PINs do not match');
      }
      await vaultManager.enablePin(pin);
      return { success: true };
    },

    'vault.pin.change': async (params) => {
      const { currentPin, newPin, newPinConfirm } = params as {
        currentPin?: string;
        newPin?: string;
        newPinConfirm?: string;
      };
      if (!currentPin || typeof currentPin !== 'string') {
        throw new Error('Current PIN is required');
      }
      if (!newPin || !/^\d{6}$/.test(newPin)) {
        throw new Error('New PIN must be exactly 6 digits');
      }
      if (newPin !== newPinConfirm) {
        throw new Error('New PINs do not match');
      }
      const unlockResult = await vaultManager.unlock(currentPin);
      if (!unlockResult.success) {
        throw new Error(
          unlockResult.error === 'locked_out'
            ? `Too many attempts. Try again in ${unlockResult.lockoutSecondsRemaining}s`
            : 'Current PIN is incorrect'
        );
      }
      await vaultManager.changePin(currentPin, newPin);
      return { success: true };
    },

    'vault.pin.remove': async (params) => {
      const { pin } = params as { pin?: string };
      if (!pin || typeof pin !== 'string') {
        throw new Error('PIN is required');
      }
      const unlockResult = await vaultManager.unlock(pin);
      if (!unlockResult.success) {
        throw new Error(
          unlockResult.error === 'locked_out'
            ? `Too many attempts. Try again in ${unlockResult.lockoutSecondsRemaining}s`
            : 'PIN is incorrect'
        );
      }
      await vaultManager.removePin(pin);
      return { success: true };
    },

    'vault.pin.forgot': async (params) => {
      const { confirmReset } = params as { confirmReset?: boolean };
      if (!confirmReset) {
        throw new Error('Confirmation required');
      }
      await vaultManager.reset();
      return { success: true };
    },
  };
}
