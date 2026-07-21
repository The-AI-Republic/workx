import type { CredentialStore } from '@/core/storage/CredentialStore';
import type { AppsAccessPolicy, OpenHubCredential } from './types';

const SERVICE = 'openhub';
const ACCOUNT = 'api_key';

export interface OpenHubCredentialProviderOptions {
  policy: AppsAccessPolicy;
  credentialStore: CredentialStore;
  managedApiKey?: string | null;
  getSessionToken?: () => Promise<string | null>;
  refreshSessionToken?: () => Promise<string | null>;
}

export class OpenHubCredentialProvider {
  private generation = 0;
  private refreshPromise: Promise<string | null> | null = null;
  private rejectedSessionToken: string | null = null;

  constructor(private readonly options: OpenHubCredentialProviderOptions) {}

  get policy(): AppsAccessPolicy {
    return this.options.policy;
  }

  async getCredential(): Promise<OpenHubCredential | null> {
    if (this.options.policy.authMethod === 'session-jwt') {
      const token = await this.options.getSessionToken?.();
      if (token && token !== this.rejectedSessionToken) this.rejectedSessionToken = null;
      if (!token || token === this.rejectedSessionToken) return null;
      return { method: 'session-jwt', token, source: 'session', generation: this.generation };
    }
    const stored = await this.options.credentialStore.get(SERVICE, ACCOUNT).catch(() => null);
    if (stored?.trim()) {
      return {
        method: 'api-key',
        token: stored.trim(),
        source: 'stored-api-key',
        generation: this.generation,
      };
    }
    const managed = this.options.managedApiKey?.trim();
    return managed
      ? {
          method: 'api-key',
          token: managed,
          source: 'managed-api-key',
          generation: this.generation,
        }
      : null;
  }

  async handleUnauthorized(failed: OpenHubCredential): Promise<OpenHubCredential | null> {
    const current = await this.getCredential();
    if (
      !current ||
      current.generation !== failed.generation ||
      current.token !== failed.token ||
      current.method !== failed.method
    ) {
      return current;
    }
    if (failed.method === 'api-key' || !this.options.refreshSessionToken) return null;
    if (!this.refreshPromise) {
      this.refreshPromise = this.options
        .refreshSessionToken()
        .then((token) => {
          if (token) this.rejectedSessionToken = null;
          else this.rejectedSessionToken = failed.token;
          this.generation++;
          return token;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    const token = await this.refreshPromise;
    if (!token) return null;
    return { method: 'session-jwt', token, source: 'session', generation: this.generation };
  }

  async saveApiKey(candidate: string): Promise<void> {
    if (this.options.policy.authMethod !== 'api-key')
      throw new Error('API-key storage is disabled by policy');
    await this.options.credentialStore.set(SERVICE, ACCOUNT, candidate);
    this.generation++;
  }

  async removeApiKey(): Promise<void> {
    if (this.options.policy.authMethod !== 'api-key')
      throw new Error('API-key storage is disabled by policy');
    await this.options.credentialStore.delete(SERVICE, ACCOUNT);
    this.generation++;
  }

  bumpGeneration(): void {
    this.generation++;
  }
}
