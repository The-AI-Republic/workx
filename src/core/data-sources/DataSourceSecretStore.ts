import type { CredentialStore } from '@/core/storage/CredentialStore';
import type { StorageProvider } from '@/core/storage/StorageProvider';
import { DataSourceError } from './errors';
import { DataSourceMutationMutex } from './DataSourceMutationMutex';

const SERVICE = 'data-source';
const VERSION_INDEX = 'data_source_secret_versions';
const ACCOUNT_PATTERN = /^([0-9a-f-]{36}):password:v([1-9][0-9]*)$/i;

interface SecretVersionIndex {
  version: 1;
  sourceId: string;
  versions: number[];
}

export class DataSourceSecretStore {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly metadata?: StorageProvider,
    private readonly metadataMutex = new DataSourceMutationMutex()
  ) {}

  static account(sourceId: string, version: number): string {
    return `${sourceId}:password:v${version}`;
  }

  getPassword(sourceId: string, version: number): Promise<string | null> {
    return this.credentials.get(SERVICE, DataSourceSecretStore.account(sourceId, version));
  }

  async setPassword(sourceId: string, version: number, value: string): Promise<void> {
    await this.credentials.set(SERVICE, DataSourceSecretStore.account(sourceId, version), value);
    if (!this.metadata) return;
    try {
      await this.metadataMutex.runExclusive(async () => {
        const versions = await this.readTrackedVersions(sourceId);
        if (!versions.includes(version)) versions.push(version);
        await this.writeTrackedVersions(sourceId, versions);
      });
    } catch (error) {
      await this.credentials
        .delete(SERVICE, DataSourceSecretStore.account(sourceId, version))
        .catch(() => undefined);
      throw error;
    }
  }

  async deletePassword(sourceId: string, version: number): Promise<void> {
    await this.credentials.delete(SERVICE, DataSourceSecretStore.account(sourceId, version));
    if (!this.metadata) return;
    await this.metadataMutex.runExclusive(async () => {
      const versions = await this.readTrackedVersions(sourceId);
      await this.writeTrackedVersions(
        sourceId,
        versions.filter((candidate) => candidate !== version)
      );
    });
  }

  async deleteAllPasswordVersions(sourceId: string, referencedVersion?: number): Promise<void> {
    let versions: number[];
    if (this.metadata) {
      versions = await this.metadataMutex.runExclusive(() => this.readTrackedVersions(sourceId));
      if (referencedVersion && !versions.includes(referencedVersion))
        versions.push(referencedVersion);
    } else {
      const prefix = `${sourceId}:password:v`;
      versions = (await this.credentials.listAccounts(SERVICE))
        .filter((account) => account.startsWith(prefix))
        .map((account) => Number(account.slice(prefix.length)))
        .filter((version) => Number.isSafeInteger(version) && version > 0);
    }
    for (const version of versions) await this.deletePassword(sourceId, version);
  }

  async reconcileReferencedVersions(references: Map<string, number>): Promise<void> {
    if (this.metadata) {
      const indexes = await this.metadataMutex.runExclusive(() =>
        this.metadata!.list<SecretVersionIndex>(VERSION_INDEX)
      );
      for (const index of indexes) {
        const versions = this.validateIndex(index, index.sourceId);
        const referencedVersion = references.get(index.sourceId);
        for (const version of versions) {
          if (version !== referencedVersion) await this.deletePassword(index.sourceId, version);
        }
      }
      return;
    }
    for (const account of await this.credentials.listAccounts(SERVICE)) {
      const match = account.match(ACCOUNT_PATTERN);
      if (!match) continue;
      const [, sourceId, versionText] = match;
      if (references.get(sourceId) !== Number(versionText))
        await this.credentials.delete(SERVICE, account);
    }
  }

  private async readTrackedVersions(sourceId: string): Promise<number[]> {
    const index = await this.metadata!.get<SecretVersionIndex>(VERSION_INDEX, sourceId);
    return index ? this.validateIndex(index, sourceId) : [];
  }

  private async writeTrackedVersions(sourceId: string, versions: number[]): Promise<void> {
    const unique = [...new Set(versions)].sort((a, b) => a - b);
    if (!unique.length) {
      await this.metadata!.delete(VERSION_INDEX, sourceId);
      return;
    }
    await this.metadata!.set<SecretVersionIndex>(VERSION_INDEX, sourceId, {
      version: 1,
      sourceId,
      versions: unique,
    });
  }

  private validateIndex(index: SecretVersionIndex, expectedSourceId: string): number[] {
    if (
      !index ||
      index.version !== 1 ||
      typeof index.sourceId !== 'string' ||
      !index.sourceId ||
      index.sourceId !== expectedSourceId ||
      !Array.isArray(index.versions) ||
      index.versions.some((version) => !Number.isSafeInteger(version) || version < 1)
    ) {
      throw new DataSourceError(
        'DATA_SOURCE_STORE_CORRUPT',
        'Data-source secret-version metadata is invalid.'
      );
    }
    return [...new Set(index.versions)].sort((a, b) => a - b);
  }
}
