/**
 * x402 key custody over the existing CredentialStore.
 *
 * Uses the canonical service/account `CredentialStore` (NOT the narrower
 * IPlatformAdapter.ICredentialStore). Per-platform backing is whatever
 * `setCredentialStore()` installed at boot:
 *   - desktop  → KeytarCredentialStore (OS keychain — strongest)
 *   - server   → FileCredentialStore (0o600 + AES-256-GCM; treat a
 *                decrypt-fail / missing VITE_VAULT_SECRET as "no key ⇒ deny")
 *   - extension → not used (NoopSigner; the extension never custodies a key)
 *
 * @module core/payments/x402/PaymentKeyStore
 */

import {
  getCredentialStore,
  isCredentialStoreInitialized,
} from '@/core/storage/CredentialStore';

const X402_SERVICE = 'x402';
const DEFAULT_ACCOUNT = 'wallet';

export class PaymentKeyStore {
  constructor(private readonly account: string = DEFAULT_ACCOUNT) {}

  /**
   * Resolve the wallet private key, or undefined if none / store unavailable.
   * Fails SAFE: any error (uninitialized store, decrypt failure that surfaces
   * as empty) resolves to undefined so the capability denies rather than
   * proceeds without a verified key.
   */
  async getPrivateKey(): Promise<string | undefined> {
    if (!isCredentialStoreInitialized()) return undefined;
    try {
      const v = await getCredentialStore().get(X402_SERVICE, this.account);
      return v ?? undefined;
    } catch {
      return undefined;
    }
  }

  async setPrivateKey(privateKeyHex: string): Promise<void> {
    if (!isCredentialStoreInitialized()) {
      throw new Error('Credential store not initialized — cannot persist x402 key');
    }
    const hex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
    if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('Invalid private key: must be 32 bytes (64 hex characters)');
    }
    await getCredentialStore().set(X402_SERVICE, this.account, `0x${hex}`);
  }

  async deletePrivateKey(): Promise<void> {
    if (!isCredentialStoreInitialized()) return;
    try {
      await getCredentialStore().delete(X402_SERVICE, this.account);
    } catch {
      /* best effort */
    }
  }

  async hasKey(): Promise<boolean> {
    return (await this.getPrivateKey()) !== undefined;
  }
}
