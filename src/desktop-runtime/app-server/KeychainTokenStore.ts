/**
 * Keychain-backed capability token store with a 0600 file fallback.
 *
 * Implements the host-agnostic {@link CapabilityTokenStore} seam so the
 * reusable app-server auth layer stays free of desktop control-bridge imports.
 *
 * @module desktop-runtime/app-server/KeychainTokenStore
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import type { CapabilityTokenStore } from '@/app-server/connection/AppServerAuth';
import type { KeychainBridge } from '@/desktop-runtime/credentials/ControlFrameCredentialStore';

const KEYCHAIN_SERVICE = 'app-server';
const KEYCHAIN_ACCOUNT = 'capability-token';

export interface KeychainTokenStoreOptions {
  keychain: KeychainBridge;
  /** Filesystem fallback path used only if the keychain is unavailable. */
  fallbackFilePath: string;
  /** Called when the fallback path is used, so the UI can warn the user. */
  onFallback?: () => void;
}

export class KeychainTokenStore implements CapabilityTokenStore {
  private usingFallback = false;

  constructor(private readonly opts: KeychainTokenStoreOptions) {}

  async getToken(): Promise<string | null> {
    try {
      const fromKeychain = await this.opts.keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (fromKeychain) return fromKeychain;
      // Fall through to file only if keychain returned nothing AND a fallback
      // file exists (keychain is the source of truth otherwise).
      if (existsSync(this.opts.fallbackFilePath)) {
        return readFileSync(this.opts.fallbackFilePath, 'utf8').trim() || null;
      }
      return null;
    } catch {
      this.useFallback();
      return existsSync(this.opts.fallbackFilePath)
        ? readFileSync(this.opts.fallbackFilePath, 'utf8').trim() || null
        : null;
    }
  }

  async setToken(token: string): Promise<void> {
    try {
      await this.opts.keychain.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
    } catch {
      this.useFallback();
      // 0600: owner read/write only.
      writeFileSync(this.opts.fallbackFilePath, token, { mode: 0o600 });
    }
  }

  async clear(): Promise<void> {
    try {
      await this.opts.keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      // ignore keychain failure
    }
    if (existsSync(this.opts.fallbackFilePath)) {
      try {
        rmSync(this.opts.fallbackFilePath);
      } catch {
        // ignore
      }
    }
  }

  private useFallback(): void {
    if (!this.usingFallback) {
      this.usingFallback = true;
      this.opts.onFallback?.();
    }
  }
}
