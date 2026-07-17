import type { CredentialStore } from '@/core/storage/CredentialStore';
import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { ListOptions, QueryFilter, Transaction } from '@/core/storage/types';
import {
  SqlReadOnlyPolicy,
  defaultDataSourcePolicy,
  type DataDescribeRequest,
  type DataQueryRequest,
  type DataResult,
  type DataSource,
  type DataSourceCapabilities,
  type DataSourceConnector,
  type DataSourceDescription,
  type DataSourceSecret,
  type DataSourceTestResult,
} from '@/core/data-sources';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStorage implements StorageProvider {
  data = new Map<string, Map<string, unknown>>();
  failNextTransaction = false;

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  private collection(name: string): Map<string, unknown> {
    let value = this.data.get(name);
    if (!value) {
      value = new Map();
      this.data.set(name, value);
    }
    return value;
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const value = this.collection(collection).get(key);
    return value === undefined ? null : clone(value as T);
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.collection(collection).set(key, clone(value));
  }

  async delete(collection: string, key: string): Promise<void> {
    this.collection(collection).delete(key);
  }

  async getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    const values = new Map<string, T>();
    for (const key of keys) {
      const value = await this.get<T>(collection, key);
      if (value !== null) values.set(key, value);
    }
    return values;
  }

  async setMany<T>(collection: string, entries: Map<string, T>): Promise<void> {
    for (const [key, value] of entries) await this.set(collection, key, value);
  }

  async deleteMany(collection: string, keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(collection, key);
  }

  async list<T>(collection: string, options: ListOptions = {}): Promise<T[]> {
    const entries = [...this.collection(collection).entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .slice(
        options.offset ?? 0,
        options.limit ? (options.offset ?? 0) + options.limit : undefined
      );
    return entries.map(([, value]) => clone(value as T));
  }

  async query<T>(collection: string, filter: QueryFilter): Promise<T[]> {
    const values = await this.list<T>(collection);
    return values.filter((value) =>
      Object.entries(filter.where ?? {}).every(
        ([key, expected]) => (value as Record<string, unknown>)[key] === expected
      )
    );
  }

  async count(collection: string, filter?: QueryFilter): Promise<number> {
    return filter
      ? (await this.query(collection, filter)).length
      : this.collection(collection).size;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const snapshot = cloneMaps(this.data);
    const tx: Transaction = {
      get: <V>(collection: string, key: string) => this.get<V>(collection, key),
      set: <V>(collection: string, key: string, value: V) => this.set(collection, key, value),
      delete: (collection: string, key: string) => this.delete(collection, key),
      commit: async () => undefined,
      abort: async () => {
        this.data = cloneMaps(snapshot);
      },
    };
    try {
      const result = await fn(tx);
      if (this.failNextTransaction) {
        this.failNextTransaction = false;
        throw new Error('injected transaction failure');
      }
      return result;
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }

  async clear(collection: string): Promise<void> {
    this.collection(collection).clear();
  }
  async vacuum(): Promise<void> {}
}

function cloneMaps(input: Map<string, Map<string, unknown>>): Map<string, Map<string, unknown>> {
  return new Map(
    [...input.entries()].map(([collection, values]) => [
      collection,
      new Map([...values.entries()].map(([key, value]) => [key, clone(value)])),
    ])
  );
}

export class MemoryCredentials implements CredentialStore {
  values = new Map<string, string>();
  failSet = false;
  failDelete = false;

  private key(service: string, account: string): string {
    return `${service}/${account}`;
  }
  async get(service: string, account: string): Promise<string | null> {
    return this.values.get(this.key(service, account)) ?? null;
  }
  async set(service: string, account: string, password: string): Promise<void> {
    if (this.failSet) throw new Error('injected credential set failure');
    this.values.set(this.key(service, account), password);
  }
  async delete(service: string, account: string): Promise<void> {
    if (this.failDelete) throw new Error('injected credential delete failure');
    this.values.delete(this.key(service, account));
  }
  async listAccounts(service: string): Promise<string[]> {
    const prefix = `${service}/`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

export function sourceFixture(
  overrides: Partial<DataSource> = {},
  connectorId: DataSource['connectorId'] = 'postgres-native'
): DataSource {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  const now = '2026-07-17T00:00:00.000Z';
  const policy = {
    ...defaultDataSourcePolicy(),
    agentAccessEnabled: true,
    leastPrivilegeAcknowledgement: { connectionRevision: 1, acknowledgedAt: now },
    ...overrides.policy,
  };
  return {
    version: 1,
    revision: 1,
    connectionRevision: 1,
    id,
    name: 'Production Sales',
    description: 'Orders and payments',
    category: 'sql',
    connectorId,
    transport: { type: 'native' },
    connection: {
      host: 'db.internal',
      port: connectorId === 'postgres-native' ? 5432 : 3306,
      database: 'sales',
      username: 'workx_reader',
      tls: { mode: 'verify-full' },
    },
    businessTimezone: 'America/Los_Angeles',
    isDefault: false,
    enabled: true,
    lifecycleState: 'active',
    secretVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastTest: {
      status: 'reachable',
      testedAt: now,
      connectionRevision: 1,
      latencyMs: 5,
      readOnlyAssessment: {
        level: 'warning',
        reasons: ['fixture'],
        userAcknowledgementRequired: true,
      },
    },
    ...overrides,
    policy,
  };
}

export class FakeConnector implements DataSourceConnector {
  readonly id: string;
  readonly policy = new SqlReadOnlyPolicy();
  testCalls: Array<{ source: DataSource; password: string }> = [];
  testHandler?: (
    source: DataSource,
    secret: DataSourceSecret,
    signal?: AbortSignal
  ) => Promise<DataSourceTestResult>;
  queryCalls: DataQueryRequest[] = [];
  queryHandler?: (
    source: DataSource,
    request: DataQueryRequest,
    signal?: AbortSignal
  ) => Promise<DataResult>;
  invalidated: string[] = [];
  schemaInvalidated: string[] = [];
  disposed = false;
  testAssessment: DataSourceTestResult['readOnlyAssessment'] = {
    level: 'warning',
    reasons: ['Use a dedicated read-only account.'],
    userAcknowledgementRequired: true,
  };

  constructor(id: 'postgres-native' | 'mysql-native' = 'postgres-native') {
    this.id = id;
  }

  getCapabilities(): DataSourceCapabilities {
    return {
      queryLanguages: ['sql'],
      schemaDiscovery: 'full',
      supportsParameters: true,
      supportsPagination: true,
      supportsCancellation: true,
      readOnlyGuarantee: 'database',
      resultShapes: ['tabular'],
    };
  }

  async testConnection(
    source: DataSource,
    secret: DataSourceSecret,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult> {
    this.testCalls.push({ source: clone(source), password: secret.password });
    if (this.testHandler) return this.testHandler(source, secret, signal);
    return {
      status: 'reachable',
      testedAt: new Date().toISOString(),
      connectionRevision: source.connectionRevision,
      latencyMs: 2,
      readOnlyAssessment: this.testAssessment,
      connectorId: this.id,
      warnings: this.testAssessment.level === 'verified' ? [] : this.testAssessment.reasons,
    };
  }

  async describe(
    source: DataSource,
    _secret: DataSourceSecret,
    request: DataDescribeRequest
  ): Promise<DataSourceDescription> {
    return {
      source: {
        id: source.id,
        name: source.name,
        description: source.description,
        category: source.category,
        connectorId: source.connectorId,
        transport: 'native',
        businessTimezone: source.businessTimezone,
        isDefault: source.isDefault,
        capabilities: {
          queryLanguages: ['sql'],
          schemaDiscovery: 'full',
          resultShapes: ['tabular'],
        },
      },
      scope: request.scope,
      objects: [
        request.scope === 'objects'
          ? {
              namespace: 'public',
              name: 'orders',
              qualifiedName: 'public.orders',
              kind: 'table',
              fields: [
                { name: 'st', databaseType: 'int', nullable: false, primaryKey: false },
                { name: 'amt', databaseType: 'int', nullable: false, primaryKey: false },
              ],
              relationships: [],
              contextFacts: [],
            }
          : {
              namespace: 'public',
              name: 'orders',
              qualifiedName: 'public.orders',
              kind: 'table',
            },
      ],
      schemaFingerprint: 'fixture-schema',
      warnings: [],
    };
  }

  validateQuery(source: DataSource, request: DataQueryRequest) {
    return this.policy.validate(source, request);
  }

  async query(
    source: DataSource,
    _secret: DataSourceSecret,
    request: DataQueryRequest,
    signal?: AbortSignal
  ): Promise<DataResult> {
    this.queryCalls.push(clone(request));
    if (this.queryHandler) return this.queryHandler(source, request, signal);
    const validation = this.validateQuery(source, request);
    if (!validation.valid) throw new Error(validation.message);
    return {
      sourceId: source.id,
      sourceName: source.name,
      shape: 'tabular',
      columns: [{ name: 'total', normalizedType: 'number' }],
      rows: [[123]],
      rowCount: 1,
      truncated: false,
      executionMs: 3,
      provenance: {
        connectorId: source.connectorId,
        transport: 'native',
        queryLanguage: 'sql',
        queryHash: 'fixture-hash',
      },
    };
  }

  async invalidateSource(sourceId: string): Promise<void> {
    this.invalidated.push(sourceId);
  }
  invalidateSchema(sourceId: string): void {
    this.schemaInvalidated.push(sourceId);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export const localPrincipal = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  origin: {
    channel: 'local' as const,
    channelId: 'desktop-runtime-main',
    channelType: 'tauri',
  },
  attended: true,
  desktopUiSession: true,
};
