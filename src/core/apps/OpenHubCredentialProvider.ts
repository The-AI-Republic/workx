import type { CredentialStore } from '@/core/storage/CredentialStore';
import type { AppsAccessPolicy, OpenHubCredential } from './types';

const SERVICE = 'openhub';
const ACCOUNT = 'api_key';

export interface OpenHubCredentialProviderOptions {
  policy: AppsAccessPolicy;
  credentialStore: CredentialStore;
  managedApiKey?: string | null;
}

export class OpenHubCredentialProvider {
  private generation = 0;

  constructor(private readonly options: OpenHubCredentialProviderOptions) {}

  get policy(): AppsAccessPolicy {
    return this.options.policy;
  }

  async getCredential(): Promise<OpenHubCredential | null> {
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
    return null;
  }

  async saveApiKey(candidate: string): Promise<void> {
    await this.options.credentialStore.set(SERVICE, ACCOUNT, candidate);
    this.generation++;
  }

  async removeApiKey(): Promise<void> {
    await this.options.credentialStore.delete(SERVICE, ACCOUNT);
    this.generation++;
  }

  bumpGeneration(): void {
    this.generation++;
  }
}
