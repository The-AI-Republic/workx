import type { StorageProvider } from '@/core/storage/StorageProvider';
import { DataSourceError } from './errors';
import { DataSourceMutationMutex } from './DataSourceMutationMutex';
import { normalizeDataSourceName } from './validation';
import type {
  DataSource,
  DataSourceCatalog,
  DataSourceContext,
  DataSourceContextEnvelope,
} from './types';

const SOURCES = 'data_sources';
const CATALOG = 'data_source_catalog';
const CONTEXTS = 'data_source_contexts';
const REVISIONS = 'data_source_context_revisions';
const CATALOG_KEY = 'catalog';

export function contextRevisionKey(sourceId: string, revision: number): string {
  return `${sourceId}:${String(revision).padStart(8, '0')}`;
}

function sourceOrder(a: DataSource, b: DataSource): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  );
}

export class DataSourceStore {
  private catalog: DataSourceCatalog = {
    version: 1,
    sourceIds: [],
    normalizedNameToId: {},
  };

  constructor(
    private readonly storage: StorageProvider,
    readonly mutex: DataSourceMutationMutex
  ) {}

  async initialize(): Promise<DataSource[]> {
    return this.mutex.runExclusive(async () => {
      const stored = await this.storage.get<DataSourceCatalog>(CATALOG, CATALOG_KEY);
      const sources = await this.storage.list<DataSource>(SOURCES);
      this.assertConsistentRecords(sources);
      if (stored) {
        this.assertCatalogMatches(stored, sources);
        this.catalog = stored;
      } else {
        this.catalog = this.buildCatalog(sources);
        await this.storage.set(CATALOG, CATALOG_KEY, this.catalog);
      }
      return this.sortSources(sources);
    });
  }

  async list(): Promise<DataSource[]> {
    const records = await this.storage.getMany<DataSource>(SOURCES, this.catalog.sourceIds);
    return this.catalog.sourceIds
      .map((id) => records.get(id))
      .filter((source): source is DataSource => Boolean(source));
  }

  getCatalogSnapshot(): DataSourceCatalog {
    return structuredClone(this.catalog);
  }

  async get(sourceId: string): Promise<DataSource | null> {
    return this.storage.get<DataSource>(SOURCES, sourceId);
  }

  async create(source: DataSource, initialContext: DataSourceContext): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.catalog.sourceIds.length >= 100) {
        throw new DataSourceError(
          'DATA_SOURCE_STORE_CORRUPT',
          'The maximum of 100 data sources has been reached.'
        );
      }
      const normalized = normalizeDataSourceName(source.name);
      if (this.catalog.normalizedNameToId[normalized]) {
        throw new DataSourceError(
          'SOURCE_REVISION_CONFLICT',
          'A data source with this name already exists.'
        );
      }
      const existing = await this.storage.get<DataSource>(SOURCES, source.id);
      if (existing)
        throw new DataSourceError('SOURCE_REVISION_CONFLICT', 'Data source ID already exists.');

      const records = await this.storage.getMany<DataSource>(SOURCES, this.catalog.sourceIds);
      const changed = new Map<string, DataSource>();
      if (source.isDefault && this.catalog.defaultSourceId) {
        const previous = records.get(this.catalog.defaultSourceId);
        if (previous)
          changed.set(previous.id, {
            ...previous,
            isDefault: false,
            revision: previous.revision + 1,
          });
      }
      const all = [...records.values()].map((item) => changed.get(item.id) ?? item).concat(source);
      const nextCatalog = this.buildCatalog(all);
      const envelope: DataSourceContextEnvelope = {
        version: 1,
        current: initialContext,
        retainedRevisions: [initialContext.revision],
      };

      await this.storage.transaction(async (tx) => {
        for (const changedSource of changed.values())
          await tx.set(SOURCES, changedSource.id, changedSource);
        await tx.set(SOURCES, source.id, source);
        await tx.set(CATALOG, CATALOG_KEY, nextCatalog);
        await tx.set(CONTEXTS, source.id, envelope);
        await tx.set(
          REVISIONS,
          contextRevisionKey(source.id, initialContext.revision),
          initialContext
        );
      });
      this.catalog = nextCatalog;
    });
  }

  async update(source: DataSource, expectedRevision: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const current = await this.storage.get<DataSource>(SOURCES, source.id);
      if (!current) throw new DataSourceError('SOURCE_NOT_FOUND', 'Data source not found.');
      if (current.revision !== expectedRevision) {
        throw new DataSourceError(
          'SOURCE_REVISION_CONFLICT',
          'The data source changed; reload before saving.'
        );
      }
      const normalized = normalizeDataSourceName(source.name);
      const sameNameOwner = this.catalog.normalizedNameToId[normalized];
      if (sameNameOwner && sameNameOwner !== source.id) {
        throw new DataSourceError(
          'SOURCE_REVISION_CONFLICT',
          'A data source with this name already exists.'
        );
      }

      const records = await this.storage.getMany<DataSource>(SOURCES, this.catalog.sourceIds);
      const changed = new Map<string, DataSource>([[source.id, source]]);
      if (
        source.isDefault &&
        this.catalog.defaultSourceId &&
        this.catalog.defaultSourceId !== source.id
      ) {
        const previous = records.get(this.catalog.defaultSourceId);
        if (previous)
          changed.set(previous.id, {
            ...previous,
            isDefault: false,
            revision: previous.revision + 1,
          });
      }
      const all = [...records.values()].map((item) => changed.get(item.id) ?? item);
      const nextCatalog = this.buildCatalog(all);
      await this.storage.transaction(async (tx) => {
        for (const changedSource of changed.values())
          await tx.set(SOURCES, changedSource.id, changedSource);
        await tx.set(CATALOG, CATALOG_KEY, nextCatalog);
      });
      this.catalog = nextCatalog;
    });
  }

  async markDeleting(sourceId: string, expectedRevision: number): Promise<DataSource> {
    return this.mutex.runExclusive(async () => {
      const current = await this.storage.get<DataSource>(SOURCES, sourceId);
      if (!current) throw new DataSourceError('SOURCE_NOT_FOUND', 'Data source not found.');
      if (current.revision !== expectedRevision) {
        throw new DataSourceError(
          'SOURCE_REVISION_CONFLICT',
          'The data source changed; reload before deleting.'
        );
      }
      const tombstone: DataSource = {
        ...current,
        revision: current.revision + 1,
        lifecycleState: 'deleting',
        enabled: false,
        isDefault: false,
        policy: { ...current.policy, agentAccessEnabled: false },
        updatedAt: new Date().toISOString(),
      };
      const records = await this.storage.getMany<DataSource>(SOURCES, this.catalog.sourceIds);
      const all = [...records.values()].map((item) => (item.id === sourceId ? tombstone : item));
      const nextCatalog = this.buildCatalog(all);
      await this.storage.transaction(async (tx) => {
        await tx.set(SOURCES, sourceId, tombstone);
        await tx.set(CATALOG, CATALOG_KEY, nextCatalog);
      });
      this.catalog = nextCatalog;
      return tombstone;
    });
  }

  async finalizeDelete(sourceId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const source = await this.storage.get<DataSource>(SOURCES, sourceId);
      if (!source) return;
      if (source.lifecycleState !== 'deleting') {
        throw new DataSourceError(
          'SOURCE_DELETION_PENDING',
          'Source must be tombstoned before deletion.'
        );
      }
      const envelope = await this.storage.get<DataSourceContextEnvelope>(CONTEXTS, sourceId);
      const remaining = (
        await this.storage.getMany<DataSource>(SOURCES, this.catalog.sourceIds)
      ).values();
      const nextCatalog = this.buildCatalog([...remaining].filter((item) => item.id !== sourceId));
      await this.storage.transaction(async (tx) => {
        await tx.delete(SOURCES, sourceId);
        await tx.delete(CONTEXTS, sourceId);
        for (const revision of envelope?.retainedRevisions ?? []) {
          await tx.delete(REVISIONS, contextRevisionKey(sourceId, revision));
        }
        await tx.set(CATALOG, CATALOG_KEY, nextCatalog);
      });
      this.catalog = nextCatalog;
    });
  }

  private sortSources(sources: DataSource[]): DataSource[] {
    return [...sources].sort(sourceOrder);
  }

  private buildCatalog(sources: DataSource[]): DataSourceCatalog {
    const sorted = this.sortSources(sources);
    const normalizedNameToId: Record<string, string> = {};
    for (const source of sorted)
      normalizedNameToId[normalizeDataSourceName(source.name)] = source.id;
    const defaultSource = sorted.find((source) => source.isDefault);
    return {
      version: 1,
      sourceIds: sorted.map((source) => source.id),
      normalizedNameToId,
      ...(defaultSource ? { defaultSourceId: defaultSource.id } : {}),
    };
  }

  private assertConsistentRecords(sources: DataSource[]): void {
    const names = new Set<string>();
    let defaults = 0;
    for (const source of sources) {
      const name = normalizeDataSourceName(source.name);
      if (names.has(name))
        throw new DataSourceError('DATA_SOURCE_STORE_CORRUPT', 'Duplicate data-source names.');
      names.add(name);
      if (source.isDefault) defaults += 1;
    }
    if (defaults > 1)
      throw new DataSourceError('DATA_SOURCE_STORE_CORRUPT', 'Multiple default data sources.');
  }

  private assertCatalogMatches(catalog: DataSourceCatalog, sources: DataSource[]): void {
    const expected = this.buildCatalog(sources);
    if (catalog.version !== 1 || JSON.stringify(catalog) !== JSON.stringify(expected)) {
      throw new DataSourceError(
        'DATA_SOURCE_STORE_CORRUPT',
        'Data-source catalog does not match stored records.'
      );
    }
  }
}
