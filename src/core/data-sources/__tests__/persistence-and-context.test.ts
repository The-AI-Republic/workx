import { describe, expect, it } from 'vitest';
import {
  ContextLearningService,
  DataContextStore,
  DataSourceMutationMutex,
  DataSourceSecretStore,
  DataSourceStore,
  createEmptyDataSourceContext,
  contextRevisionKey,
} from '@/core/data-sources';
import { localPrincipal, MemoryCredentials, MemoryStorage, sourceFixture } from './fixtures';

describe('DataSourceStore', () => {
  it('creates source and initial context atomically', async () => {
    const storage = new MemoryStorage();
    const store = new DataSourceStore(storage, new DataSourceMutationMutex());
    await store.initialize();
    const source = sourceFixture();
    const context = createEmptyDataSourceContext(source.id, source.createdAt);
    await store.create(source, context);

    expect(await store.get(source.id)).toEqual(source);
    expect(await storage.get('data_source_contexts', source.id)).toMatchObject({
      current: context,
      retainedRevisions: [1],
    });
    expect(
      await storage.get('data_source_context_revisions', contextRevisionKey(source.id, 1))
    ).toEqual(context);
  });

  it('rolls back source, catalog, and context on a transaction failure', async () => {
    const storage = new MemoryStorage();
    const store = new DataSourceStore(storage, new DataSourceMutationMutex());
    await store.initialize();
    storage.failNextTransaction = true;
    const source = sourceFixture();
    await expect(store.create(source, createEmptyDataSourceContext(source.id))).rejects.toThrow(
      'injected transaction failure'
    );
    expect(await store.get(source.id)).toBeNull();
    expect(store.getCatalogSnapshot().sourceIds).toEqual([]);
  });

  it('enforces case-insensitive unique names and one default in the same transaction', async () => {
    const storage = new MemoryStorage();
    const store = new DataSourceStore(storage, new DataSourceMutationMutex());
    await store.initialize();
    const first = sourceFixture({ isDefault: true });
    await store.create(first, createEmptyDataSourceContext(first.id));
    const duplicate = sourceFixture({
      id: '22222222-2222-4222-8222-222222222222',
      name: ' production sales ',
      isDefault: false,
    });
    await expect(
      store.create(duplicate, createEmptyDataSourceContext(duplicate.id))
    ).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CONFLICT',
    });

    const second = sourceFixture({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Finance',
      isDefault: true,
    });
    await store.create(second, createEmptyDataSourceContext(second.id));
    expect((await store.get(first.id))?.isDefault).toBe(false);
    expect((await store.get(first.id))?.revision).toBe(2);
    expect(store.getCatalogSnapshot().defaultSourceId).toBe(second.id);
  });

  it('fails closed when stored records and the catalog disagree', async () => {
    const storage = new MemoryStorage();
    const source = sourceFixture();
    await storage.set('data_sources', source.id, source);
    await storage.set('data_source_catalog', 'catalog', {
      version: 1,
      sourceIds: [],
      normalizedNameToId: {},
    });
    const store = new DataSourceStore(storage, new DataSourceMutationMutex());
    await expect(store.initialize()).rejects.toMatchObject({ code: 'DATA_SOURCE_STORE_CORRUPT' });
  });
});

describe('DataContextStore and learning', () => {
  async function setup() {
    const storage = new MemoryStorage();
    const mutex = new DataSourceMutationMutex();
    const sourceStore = new DataSourceStore(storage, mutex);
    await sourceStore.initialize();
    const source = sourceFixture();
    await sourceStore.create(source, createEmptyDataSourceContext(source.id));
    return { storage, source, store: new DataContextStore(storage, mutex) };
  }

  it('applies manual add/replace/supersede atomically and preserves history', async () => {
    const { source, store } = await setup();
    let context = await store.updateManual(source.id, {
      expectedRevision: 1,
      overviewMarkdown: 'Revenue reporting context',
      factOperations: [
        {
          operation: 'add',
          fact: {
            kind: 'unit',
            subject: { namespace: 'public', object: 'orders', field: 'amt' },
            assertion: 'orders.amt is stored in cents',
            structuredValue: { unit: 'cents' },
          },
        },
      ],
    });
    const originalId = context.facts[0].id;
    context = await store.updateManual(source.id, {
      expectedRevision: 2,
      factOperations: [
        {
          operation: 'replace',
          factId: originalId,
          fact: {
            kind: 'unit',
            subject: { namespace: 'public', object: 'orders', field: 'amt' },
            assertion: 'orders.amt is stored in US cents',
            structuredValue: { unit: 'USD cents' },
          },
        },
      ],
    });
    expect(context.facts).toHaveLength(2);
    expect(context.facts[0].status).toBe('superseded');
    expect(context.facts[1].provenance.source).toBe('settings');
    expect(await store.listRevisions(source.id)).toHaveLength(3);

    const restored = await store.revert(source.id, 2, context.revision);
    expect(restored.revision).toBe(4);
    expect(restored.overviewMarkdown).toBe('Revenue reporting context');
    expect(restored.facts).toHaveLength(1);
  });

  it('rejects stale revisions, credential-like facts, and partial manual writes', async () => {
    const { source, store } = await setup();
    await expect(
      store.updateManual(source.id, { expectedRevision: 2, overviewMarkdown: 'stale' })
    ).rejects.toMatchObject({ code: 'CONTEXT_REVISION_CONFLICT' });
    await expect(
      store.updateManual(source.id, {
        expectedRevision: 1,
        factOperations: [
          {
            operation: 'add',
            fact: { kind: 'other', subject: {}, assertion: 'api_key = sk-fixture-secret' },
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    await expect(
      store.updateManual(source.id, {
        expectedRevision: 1,
        factOperations: [
          {
            operation: 'add',
            fact: {
              kind: 'unit',
              subject: { object: 'orders', unsupported: 'payload' },
              assertion: 'Amount is in cents',
            },
          },
        ],
      } as never)
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    await expect(
      store.updateManual(source.id, {
        expectedRevision: 1,
        overviewMarkdown: 'password = do-not-store-this',
      })
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    expect((await store.get(source.id)).revision).toBe(1);
  });

  it('retains exactly the latest 50 revisions and evicts old keys transactionally', async () => {
    const { storage, source, store } = await setup();
    let revision = 1;
    for (let index = 0; index < 55; index += 1) {
      const updated = await store.updateManual(source.id, {
        expectedRevision: revision,
        overviewMarkdown: `revision ${index}`,
      });
      revision = updated.revision;
    }
    const revisions = await store.listRevisions(source.id);
    expect(revisions).toHaveLength(50);
    expect(revisions[0].revision).toBe(56);
    expect(revisions[revisions.length - 1]?.revision).toBe(7);
    expect(
      await storage.get('data_source_context_revisions', contextRevisionKey(source.id, 6))
    ).toBeNull();
  });

  it('learns exact attended user evidence, deduplicates, and fails conflicts without partial writes', async () => {
    const { source, store } = await setup();
    const service = new ContextLearningService(store);
    const turn = {
      principal: localPrincipal,
      currentUserText: 'In this database st = 2 means paid, and amt is stored in cents.',
      durableLearningEligible: true,
    };
    const schema = {
      source: {
        id: source.id,
        name: source.name,
        description: source.description,
        category: source.category,
        connectorId: source.connectorId,
        transport: 'native' as const,
        businessTimezone: source.businessTimezone,
        isDefault: source.isDefault,
        capabilities: {
          queryLanguages: ['sql' as const],
          schemaDiscovery: 'full' as const,
          resultShapes: ['tabular' as const],
        },
      },
      scope: 'objects' as const,
      objects: [
        {
          namespace: 'public',
          name: 'orders',
          qualifiedName: 'public.orders',
          kind: 'table' as const,
          fields: [
            { name: 'st', databaseType: 'int', nullable: false, primaryKey: false },
            { name: 'amt', databaseType: 'int', nullable: false, primaryKey: false },
          ],
          relationships: [],
          contextFacts: [],
        },
      ],
      schemaFingerprint: 'schema-1',
      warnings: [],
    };
    const fact = {
      kind: 'enum_value' as const,
      namespace: 'public',
      object: 'orders',
      field: 'st',
      assertion: 'st = 2 means paid',
      value: '2',
      meaning: 'paid',
      evidence_quote: 'st = 2 means paid',
    };
    const first = await service.learn(
      source,
      { source_id: source.id, facts: [fact], reason: 'User explained status' },
      turn,
      schema
    );
    expect(first.addedFacts).toHaveLength(1);
    expect(first.addedFacts[0].schemaFingerprint).toBe('schema-1');
    const duplicate = await service.learn(
      source,
      { source_id: source.id, facts: [fact], reason: 'Duplicate' },
      turn,
      schema
    );
    expect(duplicate.addedFacts).toEqual([]);
    expect(duplicate.deduplicatedFactIds).toEqual([first.addedFacts[0].id]);

    const compatible = await service.learn(
      source,
      {
        source_id: source.id,
        reason: 'Another enum value',
        facts: [
          {
            ...fact,
            assertion: 'st = 3 means refunded',
            value: '3',
            meaning: 'refunded',
            evidence_quote: 'st = 3 means refunded',
          },
        ],
      },
      { ...turn, currentUserText: 'Also, st = 3 means refunded.' },
      schema
    );
    expect(compatible.addedFacts).toHaveLength(1);

    await expect(
      service.learn(
        source,
        {
          source_id: source.id,
          reason: 'Conflicting',
          facts: [
            {
              ...fact,
              assertion: 'st = 2 means refunded',
              meaning: 'refunded',
              evidence_quote: 'st = 2 means refunded',
            },
          ],
        },
        { ...turn, currentUserText: 'Correction: st = 2 means refunded.' },
        schema
      )
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    expect((await store.get(source.id)).revision).toBe(3);
  });

  it('denies indirect evidence, missing exact quotes, temporary instructions, and ambiguous schema', async () => {
    const { source, store } = await setup();
    const service = new ContextLearningService(store);
    const baseFact = {
      kind: 'other' as const,
      assertion: 'Sales excludes test customers',
      evidence_quote: 'Sales excludes test customers',
    };
    await expect(
      service.learn(
        source,
        { source_id: source.id, facts: [baseFact], reason: 'test' },
        {
          principal: { ...localPrincipal, origin: { channel: 'remote' as const } },
          currentUserText: baseFact.assertion,
          durableLearningEligible: false,
        }
      )
    ).rejects.toMatchObject({ code: 'DATA_ACCESS_ORIGIN_DENIED' });
    await expect(
      service.learn(
        source,
        { source_id: source.id, facts: [baseFact], reason: 'test' },
        {
          principal: localPrincipal,
          currentUserText: 'Different statement',
          durableLearningEligible: true,
        }
      )
    ).rejects.toMatchObject({ code: 'CONTEXT_EVIDENCE_MISSING' });
    await expect(
      service.learn(
        source,
        {
          source_id: source.id,
          facts: [
            {
              kind: 'exclusion_rule',
              assertion: 'For this report, exclude test customers',
              evidence_quote: 'For this report, exclude test customers',
            },
          ],
          reason: 'temporary',
        },
        {
          principal: localPrincipal,
          currentUserText: 'For this report, exclude test customers',
          durableLearningEligible: true,
        }
      )
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    await expect(
      service.learn(
        source,
        {
          source_id: source.id,
          reason: 'test',
          facts: [{ ...baseFact, object: 'orders', field: 'st' }],
        },
        {
          principal: localPrincipal,
          currentUserText: baseFact.assertion,
          durableLearningEligible: true,
        }
      )
    ).rejects.toMatchObject({ code: 'CONTEXT_SCHEMA_AMBIGUOUS' });
  });
});

describe('DataSourceSecretStore', () => {
  it('uses versioned private keychain accounts and reconciles only unreferenced versions', async () => {
    const credentials = new MemoryCredentials();
    const secrets = new DataSourceSecretStore(credentials);
    const sourceId = sourceFixture().id;
    expect(DataSourceSecretStore.account(sourceId, 2)).toBe(`${sourceId}:password:v2`);
    await secrets.setPassword(sourceId, 1, 'old-password');
    await secrets.setPassword(sourceId, 2, 'current-password');
    await credentials.set('unrelated', 'account', 'keep-me');
    await secrets.reconcileReferencedVersions(new Map([[sourceId, 2]]));
    expect(await secrets.getPassword(sourceId, 1)).toBeNull();
    expect(await secrets.getPassword(sourceId, 2)).toBe('current-password');
    expect(await credentials.get('unrelated', 'account')).toBe('keep-me');
    await secrets.deleteAllPasswordVersions(sourceId);
    expect(await secrets.getPassword(sourceId, 2)).toBeNull();
  });

  it('uses a non-secret version index when the native keychain cannot enumerate accounts', async () => {
    const storage = new MemoryStorage();
    const credentials = new MemoryCredentials();
    credentials.listAccounts = async () => {
      throw new Error('Native account listing not supported');
    };
    const secrets = new DataSourceSecretStore(credentials, storage, new DataSourceMutationMutex());
    const sourceId = sourceFixture().id;
    await secrets.setPassword(sourceId, 1, 'old-password');
    await secrets.setPassword(sourceId, 2, 'current-password');

    await secrets.reconcileReferencedVersions(new Map([[sourceId, 2]]));

    expect(await secrets.getPassword(sourceId, 1)).toBeNull();
    expect(await secrets.getPassword(sourceId, 2)).toBe('current-password');
    expect(await storage.get('data_source_secret_versions', sourceId)).toEqual({
      version: 1,
      sourceId,
      versions: [2],
    });

    await secrets.deleteAllPasswordVersions(sourceId, 2);
    expect(await secrets.getPassword(sourceId, 2)).toBeNull();
    expect(await storage.get('data_source_secret_versions', sourceId)).toBeNull();
  });
});
