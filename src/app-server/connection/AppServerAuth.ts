/**
 * App-Server Capability-Token Auth
 *
 * Host-agnostic auth provider. The token is stored through an injected
 * {@link CapabilityTokenStore} so this module stays free of desktop
 * control-bridge / keychain imports (the desktop integration injects a
 * keychain-backed store; tests/headless inject an in-memory store).
 *
 * @module app-server/connection/AppServerAuth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Persistence seam for the capability token. */
export interface CapabilityTokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory token store (headless/tests). Not persisted across restarts. */
export class InMemoryTokenStore implements CapabilityTokenStore {
  private token: string | null = null;
  async getToken(): Promise<string | null> {
    return this.token;
  }
  async setToken(token: string): Promise<void> {
    this.token = token;
  }
  async clear(): Promise<void> {
    this.token = null;
  }
}

export interface AppServerAuthOptions {
  requireAuth: boolean;
  store: CapabilityTokenStore;
}

export class AppServerAuth {
  private cached: string | null = null;

  constructor(private readonly opts: AppServerAuthOptions) {}

  get requireAuth(): boolean {
    return this.opts.requireAuth;
  }

  /** Auth modes advertised in the connect challenge. */
  authModes(): string[] {
    return this.opts.requireAuth ? ['capability-token'] : ['none'];
  }

  /** Generate a new random capability token. */
  private static generate(): string {
    return randomBytes(32).toString('hex');
  }

  /** Ensure a token exists, generating and persisting one if absent. */
  async ensureToken(): Promise<string> {
    if (!this.opts.requireAuth) return '';
    let token = await this.opts.store.getToken();
    if (!token) {
      token = AppServerAuth.generate();
      await this.opts.store.setToken(token);
    }
    this.cached = token;
    return token;
  }

  /** Rotate the token, invalidating the previous value. */
  async rotateToken(): Promise<string> {
    const token = AppServerAuth.generate();
    await this.opts.store.setToken(token);
    this.cached = token;
    return token;
  }

  /** Reveal the current token (explicit UI action only). */
  async revealToken(): Promise<string | null> {
    return this.opts.store.getToken();
  }

  /**
   * Verify a presented token using constant-time comparison.
   * When auth is disabled, always returns true.
   */
  verify(presented: string | undefined): boolean {
    if (!this.opts.requireAuth) return true;
    const expected = this.cached;
    if (!expected || !presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
