import { describe, expect, it } from 'vitest';
import {
  assessContextStaleness,
  createEmptyDataSourceContext,
  renderDataSourceContext,
  type DataContextFact,
  type DataSourceDescription,
} from '@/core/data-sources';
import { sourceFixture } from './fixtures';

function fact(
  id: string,
  object: string,
  field: string | undefined,
  assertion: string
): DataContextFact {
  return {
    id,
    kind: field ? 'field_meaning' : 'object_meaning',
    subject: { namespace: 'public', object, ...(field ? { field } : {}) },
    assertion,
    status: 'active',
    provenance: { source: 'settings', createdAt: '2026-07-17T00:00:00.000Z' },
    confidence: 'user_asserted',
    schemaFingerprint: 'old-schema',
  };
}

describe('schema-aware context reads', () => {
  it('flags missing objects and fields without mutating or rendering stale facts', () => {
    const source = sourceFixture();
    const original = {
      ...createEmptyDataSourceContext(source.id),
      overviewMarkdown: 'Sales context',
      facts: [
        fact('valid', 'orders', 'amt', 'Amount is in cents'),
        fact('field-missing', 'orders', 'legacy_code', 'Legacy code maps campaigns'),
        fact('object-missing', 'old_orders', undefined, 'Historical order table'),
      ],
    };
    const description: DataSourceDescription = {
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
      scope: 'objects',
      objects: [
        {
          namespace: 'public',
          name: 'orders',
          qualifiedName: 'public.orders',
          kind: 'table',
          fields: [{ name: 'amt', databaseType: 'int', nullable: false, primaryKey: false }],
          relationships: [],
          contextFacts: [],
        },
      ],
      schemaFingerprint: 'new-schema',
      warnings: [],
    };

    const assessed = assessContextStaleness(original, description, [
      'public.orders',
      'public.old_orders',
    ]);
    expect(assessed.context.facts.find((item) => item.id === 'valid')?.stale).toBeUndefined();
    expect(assessed.context.facts.find((item) => item.id === 'field-missing')).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('legacy_code'),
    });
    expect(assessed.context.facts.find((item) => item.id === 'object-missing')).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('old_orders'),
    });
    expect(original.facts.every((item) => item.stale === undefined)).toBe(true);
    const rendered = renderDataSourceContext(assessed.context);
    expect(rendered).toContain('Amount is in cents');
    expect(rendered).not.toContain('Legacy code maps campaigns');
    expect(rendered).not.toContain('Historical order table');
  });

  it('does not mark facts outside a partial describe request stale', () => {
    const source = sourceFixture();
    const context = {
      ...createEmptyDataSourceContext(source.id),
      facts: [fact('not-requested', 'customers', 'segment', 'Customer segment meaning')],
    };
    const assessed = assessContextStaleness(
      context,
      {
        source: {} as DataSourceDescription['source'],
        scope: 'objects',
        objects: [],
        schemaFingerprint: 'schema',
        warnings: [],
      },
      ['public.orders']
    );
    expect(assessed.context.facts[0].stale).toBeUndefined();
    expect(assessed.warnings).toEqual([]);
  });
});
