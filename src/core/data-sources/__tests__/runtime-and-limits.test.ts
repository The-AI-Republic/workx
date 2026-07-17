import { describe, expect, it, vi } from 'vitest';
import {
  DataContextStore,
  DataResultLimiter,
  DataSourceAccessPolicy,
  DataSourceError,
  DataSourceMutationMutex,
  DataSourceRegistry,
  DataSourceRuntime,
  DataSourceSecretStore,
  DataSourceStore,
  SourceQuerySemaphore,
  createEmptyDataSourceContext,
} from '@/core/data-sources';
import type { CreateDataSourceFields, DataQueryRequest, DataResult } from '@/core/data-sources';
import {
  FakeConnector,
  localPrincipal,
  MemoryCredentials,
  MemoryStorage,
  sourceFixture,
} from './fixtures';
import { createDesktopDataSourceRuntime } from '@/desktop-runtime/data-sources/createDesktopDataSourceRuntime';

function editable(source = sourceFixture()): CreateDataSourceFields {
  const policy = { ...source.policy };
  delete policy.leastPrivilegeAcknowledgement;
  return {
    name: source.name,
    description: source.description,
    category: source.category,
    connectorId: source.connectorId,
    transport: source.transport,
    connection: source.connection,
    businessTimezone: source.businessTimezone,
    isDefault: source.isDefault,
    enabled: source.enabled,
    policy,
  };
}

export async function setupRuntime() {
  const storage = new MemoryStorage();
  const credentials = new MemoryCredentials();
  const mutex = new DataSourceMutationMutex();
  const sourceStore = new DataSourceStore(storage, mutex);
  await sourceStore.initialize();
  const contextStore = new DataContextStore(storage, mutex);
  const secretStore = new DataSourceSecretStore(credentials);
  const registry = new DataSourceRegistry();
  const postgres = new FakeConnector('postgres-native');
  const mysql = new FakeConnector('mysql-native');
  registry.registerConnector(postgres);
  registry.registerConnector(mysql);
  const audit = vi.fn();
  const runtime = new DataSourceRuntime({
    sourceStore,
    contextStore,
    secretStore,
    registry,
    audit,
  });
  return {
    storage,
    credentials,
    sourceStore,
    contextStore,
    secretStore,
    registry,
    postgres,
    mysql,
    audit,
    runtime,
  };
}

async function create(runtime: DataSourceRuntime, overrides: Partial<CreateDataSourceFields> = {}) {
  return runtime.createSource({
    source: { ...editable(), ...overrides },
    password: 'fixture-password',
    leastPrivilegeAcknowledged: true,
  });
}

describe('DataSourceRegistry and DataSourceRuntime', () => {
  it('reconciles orphan secret versions and resumes deletion tombstones before loading active sources', async () => {
    const storage = new MemoryStorage();
    const credentials = new MemoryCredentials();
    const mutex = new DataSourceMutationMutex();
    const store = new DataSourceStore(storage, mutex);
    await store.initialize();
    const active = sourceFixture({ secretVersion: 2 });
    const deleting = sourceFixture({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Deleting Source',
    });
    await store.create(active, createEmptyDataSourceContext(active.id));
    await store.create(deleting, createEmptyDataSourceContext(deleting.id));
    await store.markDeleting(deleting.id, deleting.revision);
    const secrets = new DataSourceSecretStore(credentials);
    await secrets.setPassword(active.id, 1, 'orphan');
    await secrets.setPassword(active.id, 2, 'current');
    await secrets.setPassword(deleting.id, 1, 'delete-me');

    const runtime = await createDesktopDataSourceRuntime({ storage, credentials });
    expect(runtime.getSourceForAssessment(active.id).id).toBe(active.id);
    expect(() => runtime.getSourceForAssessment(deleting.id)).toThrow();
    expect(await secrets.getPassword(active.id, 1)).toBeNull();
    expect(await secrets.getPassword(active.id, 2)).toBe('current');
    expect(await secrets.getPassword(deleting.id, 1)).toBeNull();
    expect(await store.get(deleting.id)).toBeNull();
    await runtime.dispose();
  });

  it('supports multiple sources and keeps the single-default registry view synchronized', async () => {
    const { runtime, registry, postgres } = await setupRuntime();
    const first = await create(runtime, { isDefault: true });
    const second = await create(runtime, {
      name: 'Finance',
      isDefault: true,
      connection: { ...editable().connection, database: 'finance' },
    });
    expect(postgres.testCalls).toHaveLength(2);
    expect(registry.listSources()).toHaveLength(2);
    expect(registry.getSource(first.source.id).isDefault).toBe(false);
    expect(registry.getSource(first.source.id).revision).toBe(2);
    expect(registry.getSource(second.source.id).isDefault).toBe(true);
  });

  it('never returns passwords or secret versions from management views', async () => {
    const { runtime } = await setupRuntime();
    const source = await create(runtime);
    const serialized = JSON.stringify(source);
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('secretVersion');
    expect(source.passwordConfigured).toBe(true);
  });

  it('retests exact saves and binds warning acknowledgement to connection revision', async () => {
    const { runtime, postgres, secretStore } = await setupRuntime();
    const created = await create(runtime);
    const updated = await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: {
        connection: { ...created.source.connection, database: 'sales_v2' },
      },
      passwordAction: 'replace',
      password: 'replacement-password',
      leastPrivilegeAcknowledged: true,
    });
    expect(updated.source.connectionRevision).toBe(2);
    expect(updated.source.lastTest?.connectionRevision).toBe(2);
    expect(updated.source.policy.leastPrivilegeAcknowledgement?.connectionRevision).toBe(2);
    expect(postgres.testCalls[postgres.testCalls.length - 1]).toMatchObject({
      password: 'replacement-password',
    });
    expect(postgres.invalidated).toContain(created.source.id);
    expect(await secretStore.getPassword(created.source.id, 1)).toBeNull();
    expect(await secretStore.getPassword(created.source.id, 2)).toBe('replacement-password');
  });

  it('does not increment connection revision or retest metadata-only edits', async () => {
    const { runtime, postgres } = await setupRuntime();
    const created = await create(runtime);
    const testCalls = postgres.testCalls.length;
    const updated = await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: { description: 'Updated business description' },
      passwordAction: 'keep',
    });
    expect(updated.source.connectionRevision).toBe(created.source.connectionRevision);
    expect(postgres.testCalls).toHaveLength(testCalls);
  });

  it('clears the default transactionally when that source is disabled for agent access', async () => {
    const { runtime, registry } = await setupRuntime();
    const created = await create(runtime, { isDefault: true });
    const updated = await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: {
        isDefault: true,
        policy: { ...editable().policy, agentAccessEnabled: false },
      },
      passwordAction: 'keep',
    });
    expect(updated.source).toMatchObject({ isDefault: false });
    expect(updated.source.policy.agentAccessEnabled).toBe(false);
    expect(registry.getSource(created.source.id).isDefault).toBe(false);
  });

  it('invalidates schema but preserves the pool when only allowlists change', async () => {
    const { runtime, postgres } = await setupRuntime();
    const created = await create(runtime);
    await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: {
        policy: {
          ...editable().policy,
          allowedNamespaces: ['public'],
          allowedObjects: ['public.orders'],
        },
      },
      passwordAction: 'keep',
    });
    expect(postgres.schemaInvalidated).toEqual([created.source.id]);
    expect(postgres.invalidated).toEqual([]);
  });

  it('checks stored context against current schema and never attaches stale facts', async () => {
    const { runtime, contextStore } = await setupRuntime();
    const created = await create(runtime);
    await contextStore.updateManual(created.source.id, {
      expectedRevision: 1,
      factOperations: [
        {
          operation: 'add',
          fact: {
            kind: 'field_meaning',
            subject: { namespace: 'public', object: 'orders', field: 'removed_field' },
            assertion: 'Removed field was a legacy sales code.',
          },
        },
      ],
    });

    const context = await runtime.getContext(created.source.id, localPrincipal, true);
    expect(context.facts[0]).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('removed_field'),
    });

    const description = await runtime.describe(
      {
        source_id: created.source.id,
        scope: 'objects',
        objects: ['public.orders'],
        include_context: true,
      },
      localPrincipal
    );
    expect(description.objects[0]).toMatchObject({ contextFacts: [] });
    expect(description.renderedContext).not.toContain('legacy sales code');
    expect(description.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('removed_field')])
    );
  });

  it('does not persist a source when the secret succeeds but storage commit fails', async () => {
    const { runtime, storage, credentials } = await setupRuntime();
    storage.failNextTransaction = true;
    await expect(create(runtime)).rejects.toThrow('injected transaction failure');
    expect(await credentials.listAccounts('data-source')).toEqual([]);
  });

  it('rejects stale saved-source tests without attaching results', async () => {
    const { runtime } = await setupRuntime();
    const created = await create(runtime);
    await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: { description: 'newer edit' },
      passwordAction: 'keep',
    });
    await expect(
      runtime.testSource(created.source.id, created.source.revision)
    ).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CONFLICT',
    });
  });

  it('rejects a saved-source test that becomes stale while the network test is running', async () => {
    const { runtime, postgres } = await setupRuntime();
    const created = await create(runtime);
    let testStarted!: () => void;
    let releaseTest!: () => void;
    const started = new Promise<void>((resolve) => {
      testStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseTest = resolve;
    });
    postgres.testHandler = async (source) => {
      testStarted();
      await gate;
      return {
        status: 'reachable',
        testedAt: new Date().toISOString(),
        connectionRevision: source.connectionRevision,
        latencyMs: 1,
        readOnlyAssessment: {
          level: 'verified',
          reasons: ['fixture'],
          userAcknowledgementRequired: false,
        },
        connectorId: source.connectorId,
        warnings: [],
      };
    };
    const pending = runtime.testSource(created.source.id, created.source.revision);
    await started;
    const edited = await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: { description: 'Edited while the connection test was running' },
      passwordAction: 'keep',
    });
    releaseTest();
    await expect(pending).rejects.toMatchObject({ code: 'SOURCE_REVISION_CONFLICT' });
    expect(runtime.getSourceForAssessment(created.source.id)).toMatchObject({
      revision: edited.source.revision,
      description: 'Edited while the connection test was running',
    });
  });

  it('denies remote/unattended access before connector dispatch and remains authoritative', async () => {
    const { runtime, postgres } = await setupRuntime();
    const created = await create(runtime);
    const remote = {
      ...localPrincipal,
      origin: { channel: 'remote' as const, channelType: 'websocket' },
      desktopUiSession: false,
    };
    await expect(runtime.listSources({}, remote)).resolves.toEqual({ sources: [] });
    await expect(
      runtime.query(
        {
          source_id: created.source.id,
          query_language: 'sql',
          query: 'SELECT count(*) FROM orders',
          purpose: 'remote attempt',
        },
        remote
      )
    ).rejects.toMatchObject({ code: 'DATA_ACCESS_ORIGIN_DENIED' });
    expect(postgres.queryCalls).toEqual([]);
  });

  it('executes one bounded analytical connector call and emits metadata-only audit', async () => {
    const { runtime, postgres, audit } = await setupRuntime();
    const created = await create(runtime);
    const request: DataQueryRequest = {
      source_id: created.source.id,
      query_language: 'sql',
      query: 'SELECT count(*) AS total FROM orders WHERE st = $1',
      parameters: [{ type: 'number', value: 2 }],
      purpose: 'Monthly paid order total',
    };
    const result = await runtime.query(request, localPrincipal);
    expect(result.rows).toEqual([[123]]);
    expect(postgres.queryCalls).toEqual([request]);
    const queryAudit = audit.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.operation === 'query');
    expect(queryAudit).toMatchObject({
      sourceId: created.source.id,
      connectorId: 'postgres-native',
      rowCount: 1,
      queryHash: 'fixture-hash',
      success: true,
    });
    expect(JSON.stringify(queryAudit)).not.toContain(request.query);
    expect(JSON.stringify(queryAudit)).not.toContain('Monthly paid');
    expect(JSON.stringify(queryAudit)).not.toContain('fixture-password');
  });

  it('revalidates queued work against the latest allowlist before resolving credentials', async () => {
    const { runtime, postgres, secretStore } = await setupRuntime();
    const created = await create(runtime);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    postgres.queryHandler = async (source) => {
      await firstGate;
      return {
        sourceId: source.id,
        sourceName: source.name,
        shape: 'tabular',
        columns: [{ name: 'total', normalizedType: 'number' }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        executionMs: 1,
        provenance: {
          connectorId: source.connectorId,
          transport: 'native',
          queryLanguage: 'sql',
          queryHash: 'queued-hash',
        },
      };
    };
    const request: DataQueryRequest = {
      source_id: created.source.id,
      query_language: 'sql',
      query: 'SELECT count(*) FROM public.orders',
      purpose: 'Queued allowlist recheck',
    };
    const first = runtime.query(request, localPrincipal);
    await vi.waitFor(() => expect(postgres.queryCalls).toHaveLength(1));
    const second = runtime.query(request, localPrincipal);
    await runtime.updateSource(created.source.id, {
      expectedRevision: created.source.revision,
      patch: {
        policy: {
          ...editable().policy,
          allowedNamespaces: ['public'],
          allowedObjects: ['public.customers'],
        },
      },
      passwordAction: 'keep',
    });
    const passwordLookup = vi.spyOn(secretStore, 'getPassword');
    releaseFirst();
    await expect(first).resolves.toMatchObject({ rows: [[1]] });
    await expect(second).rejects.toMatchObject({ code: 'QUERY_OBJECT_DENIED' });
    expect(postgres.queryCalls).toHaveLength(1);
    expect(passwordLookup).not.toHaveBeenCalled();
  });

  it('resumes tombstone cleanup after a failed secret deletion', async () => {
    const { runtime, credentials, sourceStore, registry } = await setupRuntime();
    const created = await create(runtime);
    credentials.failDelete = true;
    await expect(
      runtime.deleteSource(created.source.id, created.source.revision)
    ).rejects.toMatchObject({
      code: 'SOURCE_DELETION_PENDING',
    });
    expect((await sourceStore.get(created.source.id))?.lifecycleState).toBe('deleting');
    expect(registry.getSource(created.source.id).lifecycleState).toBe('deleting');
    credentials.failDelete = false;
    await runtime.resumePendingDeletions();
    expect(await sourceStore.get(created.source.id)).toBeNull();
  });

  it('cancels the active database operation before deleting its source', async () => {
    const { runtime, postgres } = await setupRuntime();
    const created = await create(runtime);
    let started = false;
    postgres.queryHandler = (_source, _request, signal) =>
      new Promise((_resolve, reject) => {
        started = true;
        signal?.addEventListener(
          'abort',
          () => reject(new DataSourceError('QUERY_CANCELLED', 'Query was cancelled.')),
          { once: true }
        );
      });
    const pending = runtime.query(
      {
        source_id: created.source.id,
        query_language: 'sql',
        query: 'SELECT pg_sleep(30)',
        purpose: 'Deletion cancellation test',
      },
      localPrincipal
    );
    await vi.waitFor(() => expect(started).toBe(true));
    await runtime.deleteSource(created.source.id, created.source.revision);
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    expect(postgres.invalidated).toContain(created.source.id);
  });

  it('disposes every connector and blocks operations during shutdown', async () => {
    const { runtime, postgres, mysql } = await setupRuntime();
    await runtime.dispose();
    expect(postgres.disposed).toBe(true);
    expect(mysql.disposed).toBe(true);
    await expect(runtime.listManagementSources()).rejects.toMatchObject({
      code: 'DATA_SOURCES_UNAVAILABLE',
    });
  });
});

describe('access, concurrency, and result limits', () => {
  it.each([
    ['disabled source', sourceFixture({ enabled: false }), 'SOURCE_DISABLED'],
    [
      'agent access disabled',
      sourceFixture({ policy: { ...sourceFixture().policy, agentAccessEnabled: false } }),
      'AGENT_ACCESS_DISABLED',
    ],
    ['stale test', sourceFixture({ connectionRevision: 2 }), 'AGENT_ACCESS_DISABLED'],
    ['deleting', sourceFixture({ lifecycleState: 'deleting' }), 'SOURCE_DELETION_PENDING'],
  ])('fails the runtime gate for %s', async (_label, source, code) => {
    await expect(
      new DataSourceAccessPolicy().assertAgentAccess(source, localPrincipal)
    ).rejects.toMatchObject({ code });
  });

  it('serializes same-source work, queues four calls, and rejects overflow', async () => {
    const semaphore = new SourceQuerySemaphore();
    const first = await semaphore.acquire();
    const queued = Array.from({ length: 4 }, () => semaphore.acquire());
    await expect(semaphore.acquire()).rejects.toMatchObject({ code: 'QUERY_BUSY' });
    first();
    for (const pending of queued) {
      const release = await pending;
      release();
    }
  });

  it('cancels queued queries without disturbing the active query', async () => {
    const semaphore = new SourceQuerySemaphore();
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    release();
    await expect(semaphore.acquire()).resolves.toBeTypeOf('function');
  });

  it('bounds rows, multibyte text, JSON, binary, bigints, and giant cells below 40k', () => {
    const input: DataResult = {
      sourceId: 'source',
      sourceName: 'Sales',
      shape: 'tabular',
      columns: Array.from({ length: 50 }, (_, index) => ({
        name: `column_${index}`,
        normalizedType: 'mixed' as const,
      })),
      rows: Array.from({ length: 100 }, (_, row) =>
        Array.from({ length: 50 }, (_, column) =>
          column === 0
            ? '🙂'.repeat(5_000)
            : column === 1
              ? BigInt(row)
              : column === 2
                ? Buffer.from('private')
                : { row, column }
        )
      ),
      rowCount: 100,
      truncated: false,
      executionMs: 1,
      provenance: {
        connectorId: 'postgres-native',
        transport: 'native',
        queryLanguage: 'sql',
        queryHash: 'hash',
      },
    };
    const limited = new DataResultLimiter().limit(input, 20);
    expect(limited.truncated).toBe(true);
    expect(limited.truncationReasons).toEqual(
      expect.arrayContaining(['row_limit', 'cell_size', 'result_size'])
    );
    expect(JSON.stringify(limited).length).toBeLessThan(40_000);
    expect(limited.rows?.[0]?.[1]).toBe('0');
    expect(limited.rows?.[0]?.[2]).toEqual({ omitted: true, type: 'binary', bytes: 7 });
  });

  it('documents the post-decode limitation while bounding non-tabular results', () => {
    const giant = 'x'.repeat(100_000);
    const result: DataResult = {
      sourceId: 'source',
      sourceName: 'Sales',
      shape: 'documents',
      documents: [{ giant }],
      rowCount: 1,
      truncated: false,
      executionMs: 1,
      provenance: {
        connectorId: 'future-mcp',
        transport: 'mcp',
        queryLanguage: 'graphql',
        queryHash: 'hash',
      },
    };
    const limited = new DataResultLimiter().limit(result, 10);
    expect(limited.documents).toBeUndefined();
    expect(limited.truncated).toBe(true);
    expect(JSON.stringify(limited).length).toBeLessThan(40_000);
  });
});
