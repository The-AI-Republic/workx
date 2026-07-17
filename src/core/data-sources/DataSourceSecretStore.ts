import type { CredentialStore } from '@/core/storage/CredentialStore';

const SERVICE = 'data-source';
const ACCOUNT_PATTERN = /^([0-9a-f-]{36}):password:v([1-9][0-9]*)$/i;

export class DataSourceSecretStore {
  constructor(private readonly credentials: CredentialStore) {}

  static account(sourceId: string, version: number): string {
    return `${sourceId}:password:v${version}`;
  }

  getPassword(sourceId: string, version: number): Promise<string | null> {
    return this.credentials.get(SERVICE, DataSourceSecretStore.account(sourceId, version));
  }

  setPassword(sourceId: string, version: number, value: string): Promise<void> {
    return this.credentials.set(SERVICE, DataSourceSecretStore.account(sourceId, version), value);
  }

  deletePassword(sourceId: string, version: number): Promise<void> {
    return this.credentials.delete(SERVICE, DataSourceSecretStore.account(sourceId, version));
  }

  async deleteAllPasswordVersions(sourceId: string): Promise<void> {
    const prefix = `${sourceId}:password:v`;
    const accounts = await this.credentials.listAccounts(SERVICE);
    await Promise.all(
      accounts
        .filter((account) => account.startsWith(prefix))
        .map((account) => this.credentials.delete(SERVICE, account))
    );
  }

  async reconcileReferencedVersions(references: Map<string, number>): Promise<void> {
    for (const account of await this.credentials.listAccounts(SERVICE)) {
      const match = account.match(ACCOUNT_PATTERN);
      if (!match) continue;
      const [, sourceId, versionText] = match;
      if (references.get(sourceId) !== Number(versionText))
        await this.credentials.delete(SERVICE, account);
    }
  }
}
