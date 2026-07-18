import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { CredentialStore } from '@/core/storage/CredentialStore';
import {
  DataContextStore,
  DataSourceAccessPolicy,
  DataSourceMutationMutex,
  DataSourceRegistry,
  DataSourceRuntime,
  DataSourceSecretStore,
  DataSourceStore,
  type DataPrincipalAuthorizer,
  type DataSourceAuditEvent,
} from '@/core/data-sources';
import { MySqlNativeConnector } from './native/MySqlNativeConnector';
import { PostgresNativeConnector } from './native/PostgresNativeConnector';

export interface CreateDesktopDataSourceRuntimeOptions {
  storage: StorageProvider;
  credentials: CredentialStore;
  authorizePrincipal?: DataPrincipalAuthorizer;
  audit?: (event: DataSourceAuditEvent) => void;
}

export async function createDesktopDataSourceRuntime(
  options: CreateDesktopDataSourceRuntimeOptions
): Promise<DataSourceRuntime> {
  const mutex = new DataSourceMutationMutex();
  const sourceStore = new DataSourceStore(options.storage, mutex);
  const contextStore = new DataContextStore(options.storage, mutex);
  const secretStore = new DataSourceSecretStore(options.credentials, options.storage, mutex);
  const registry = new DataSourceRegistry();
  registry.registerConnector(new PostgresNativeConnector());
  registry.registerConnector(new MySqlNativeConnector());

  await sourceStore.initialize();
  const runtime = new DataSourceRuntime({
    sourceStore,
    contextStore,
    secretStore,
    registry,
    accessPolicy: new DataSourceAccessPolicy(options.authorizePrincipal),
    audit: options.audit,
  });
  await runtime.resumePendingDeletions();

  const sources = await sourceStore.list();
  await secretStore.reconcileReferencedVersions(
    new Map(sources.map((source) => [source.id, source.secretVersion]))
  );
  for (const source of sources) {
    if (source.lifecycleState === 'active') registry.upsertSource(source);
  }
  return runtime;
}
