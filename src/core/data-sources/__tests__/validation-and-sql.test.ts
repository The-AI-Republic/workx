import { describe, expect, it } from 'vitest';
import {
  DataSourceError,
  SqlReadOnlyPolicy,
  asDataSourceError,
  dataQueryParameterTypes,
  defaultDataSourcePolicy,
  encodeDataQueryParameters,
  normalizeDataSourceName,
  sanitizeDataSourceMessage,
  validateCandidateInput,
  validateDataDescribeRequest,
  validateDataQueryRequest,
  validateLearnContextRequest,
  validateSourceFields,
  validateUpdateInput,
} from '@/core/data-sources';
import type { CreateDataSourceFields, DataQueryRequest, DataSource } from '@/core/data-sources';
import { sourceFixture } from './fixtures';

function fields(overrides: Partial<CreateDataSourceFields> = {}): CreateDataSourceFields {
  const source = sourceFixture();
  const policy = { ...source.policy };
  delete policy.leastPrivilegeAcknowledgement;
  return {
    name: source.name,
    description: source.description,
    category: 'sql',
    connectorId: source.connectorId,
    transport: source.transport,
    connection: source.connection,
    businessTimezone: source.businessTimezone,
    isDefault: false,
    enabled: true,
    policy,
    ...overrides,
  };
}

function request(query: string, parameterCount = 0): DataQueryRequest {
  return {
    source_id: sourceFixture().id,
    query_language: 'sql',
    query,
    parameters: Array.from({ length: parameterCount }, () => ({ type: 'number', value: 1 })),
    purpose: 'Test the policy',
  };
}

describe('data-source validation', () => {
  it('normalizes names, bracketed IPv6 hosts, and allowlists', () => {
    const parsed = validateSourceFields(
      fields({
        name: '  Sales  ',
        connection: {
          ...sourceFixture().connection,
          host: '[2001:db8::1]',
        },
        policy: {
          ...defaultDataSourcePolicy(),
          allowedNamespaces: [' public ', 'public'],
          allowedObjects: ['public.orders', 'public.orders'],
        },
      })
    );
    expect(parsed.name).toBe('Sales');
    expect(parsed.connection.host).toBe('2001:db8::1');
    expect(parsed.policy.allowedNamespaces).toEqual(['public']);
    expect(normalizeDataSourceName(' ＳＡＬＥＳ ')).toBe('sales');
  });

  it.each([
    [
      'credential-bearing URI',
      fields({ connection: { ...sourceFixture().connection, host: 'postgres://u:p@db/sales' } }),
    ],
    ['invalid timezone', fields({ businessTimezone: 'Mars/Olympus' })],
    [
      'CA with disabled TLS',
      fields({
        connection: {
          ...sourceFixture().connection,
          tls: { mode: 'disable', caPem: 'certificate' },
        },
      }),
    ],
    [
      'inaccessible default',
      fields({
        isDefault: true,
        policy: { ...defaultDataSourcePolicy(), agentAccessEnabled: false },
      }),
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => validateSourceFields(value)).toThrow();
  });

  it('requires explicit password replacement semantics and preserves password whitespace', () => {
    expect(validateCandidateInput({ source: fields(), password: '  secret  ' }).password).toBe(
      '  secret  '
    );
    expect(() =>
      validateUpdateInput({ expectedRevision: 1, patch: {}, passwordAction: 'replace' })
    ).toThrow(DataSourceError);
    expect(() =>
      validateUpdateInput({ expectedRevision: 0, patch: {}, passwordAction: 'keep' })
    ).toThrow(DataSourceError);
  });

  it('validates bounded typed query parameters', () => {
    const valid: DataQueryRequest = {
      ...request('SELECT $1, $2, $3, $4, $5', 0),
      parameters: [
        { type: 'string', value: 'paid' },
        { type: 'number', value: 2 },
        { type: 'boolean', value: true },
        { type: 'null' },
        { type: 'date', value: '2026-07-01T00:00:00Z' },
      ],
    };
    expect(() => validateDataQueryRequest(valid)).not.toThrow();
    expect(encodeDataQueryParameters(valid.parameters)).toEqual([
      'paid',
      2,
      true,
      null,
      '2026-07-01T00:00:00Z',
    ]);
    expect(dataQueryParameterTypes(valid.parameters)).toEqual([
      'string',
      'number',
      'boolean',
      'null',
      'date',
    ]);
    expect(() =>
      validateDataQueryRequest({ ...valid, parameters: [{ type: 'number', value: Number.NaN }] })
    ).toThrow();
    expect(() => encodeDataQueryParameters([{ type: 'date', value: 'not-a-date' }])).toThrow();
    expect(() =>
      validateDataQueryRequest({
        ...valid,
        parameters: [{ type: 'null', value: 'smuggled' }],
      })
    ).toThrow();
  });

  it('validates describe and learning payloads again at the runtime boundary', () => {
    expect(
      validateDataDescribeRequest({
        source_id: sourceFixture().id,
        scope: 'objects',
        objects: ['public.orders'],
      }).objects
    ).toEqual(['public.orders']);
    expect(() =>
      validateDataDescribeRequest({
        source_id: sourceFixture().id,
        scope: 'objects',
        objects: ['unqualified'],
      })
    ).toThrow();
    expect(() =>
      validateLearnContextRequest({
        source_id: sourceFixture().id,
        facts: [{ kind: 'other', assertion: 'too short quote', evidence_quote: 'short' }],
        reason: 'test',
      })
    ).toThrow();
  });

  it('sanitizes credentials, certificates, hosts, users, and driver diagnostics', () => {
    const raw =
      'postgres://reader:secret@db.internal/sales host=private.example user=reader ECONNREFUSED 10.0.0.4:5432 -----BEGIN CERTIFICATE----- private-ca -----END CERTIFICATE-----';
    const sanitized = sanitizeDataSourceMessage(raw);
    expect(sanitized).not.toContain('reader:secret');
    expect(sanitized).not.toContain('private.example');
    expect(sanitized).not.toContain('10.0.0.4');
    expect(sanitized).not.toContain('private-ca');
    const mapped = asDataSourceError(
      new Error('syntax error near SELECT secret FROM private_table'),
      'QUERY_PARSE_FAILED'
    );
    expect(mapped.message).toBe('Database query failed.');
    expect(mapped.message).not.toContain('SELECT');
  });
});

describe('SqlReadOnlyPolicy security corpus', () => {
  const policy = new SqlReadOnlyPolicy();

  function validate(sql: string, source: DataSource = sourceFixture(), parameters = 0) {
    return policy.validate(source, request(sql, parameters));
  }

  it.each([
    'SELECT count(*) FROM orders',
    "WITH recent AS (SELECT * FROM orders WHERE created_at >= now() - interval '30 days') SELECT count(*) FROM recent",
    'SELECT customer_id, sum(amount) OVER (PARTITION BY customer_id) FROM orders',
    'SELECT * FROM orders WHERE id IN (SELECT order_id FROM payments)',
    'SELECT id FROM orders UNION ALL SELECT order_id FROM payments',
    'SELECT o.id, p.amount FROM orders o JOIN payments p ON p.order_id = o.id',
  ])('accepts bounded analytical shape: %s', (sql) => {
    const result = validate(sql);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.safeSql).not.toMatch(/;\s*$/);
  });

  it('preserves PostgreSQL placeholders, including duplicate references', () => {
    const result = validate(
      'SELECT * FROM orders WHERE st = $1 OR prior_st = $1',
      sourceFixture(),
      1
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.safeSql.match(/\$1/g)?.length).toBe(2);
      expect(result.placeholderCount).toBe(1);
    }
  });

  it('preserves MySQL placeholders and ignores question marks in text/comments', () => {
    const mysql = sourceFixture({}, 'mysql-native');
    const result = validate("SELECT '?' AS literal, id FROM orders WHERE st = ? /* ? */", mysql, 1);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.safeSql).toContain('?');
  });

  it.each([
    'INSERT INTO orders(id) VALUES (1)',
    'UPDATE orders SET st = 2',
    'DELETE FROM orders',
    'CREATE TABLE stolen(id int)',
    'DROP TABLE orders',
    'SELECT * FROM orders; DELETE FROM orders',
    'WITH changed AS (DELETE FROM orders RETURNING *) SELECT * FROM changed',
    'SELECT * INTO copied_orders FROM orders',
  ])('rejects write/multiple/export SQL before execution: %s', (sql) => {
    expect(validate(sql).valid).toBe(false);
  });

  it.each([
    'SELECT * FROM orders FOR UPDATE',
    'SELECT * FROM orders LOCK IN SHARE MODE',
    "SELECT * FROM orders INTO OUTFILE '/tmp/orders'",
    "SELECT * FROM orders INTO DUMPFILE '/tmp/orders'",
    "LOAD DATA INFILE '/tmp/orders' INTO TABLE orders",
  ])('rejects MySQL locking/export/load syntax: %s', (sql) => {
    expect(validate(sql, sourceFixture({}, 'mysql-native')).valid).toBe(false);
  });

  it('enforces contiguous and exact parameter counts', () => {
    expect(validate('SELECT * FROM orders WHERE a = $2', sourceFixture(), 1)).toMatchObject({
      valid: false,
      code: 'QUERY_PARAMETER_MISMATCH',
    });
    expect(validate('SELECT * FROM orders WHERE a = $1', sourceFixture(), 0)).toMatchObject({
      valid: false,
      code: 'QUERY_PARAMETER_MISMATCH',
    });
  });

  it('normalizes quoted mixed-case names before enforcing object allowlists', () => {
    const source = sourceFixture({
      policy: {
        ...sourceFixture().policy,
        allowedNamespaces: ['public'],
        allowedObjects: ['public.orders'],
      },
    });
    expect(validate('SELECT * FROM "public"."Orders"', source).valid).toBe(true);
    expect(validate('SELECT * FROM "private"."Orders"', source)).toMatchObject({
      valid: false,
      code: 'QUERY_OBJECT_DENIED',
    });
    expect(validate('SELECT * FROM "public"."Other"', source)).toMatchObject({
      valid: false,
      code: 'QUERY_OBJECT_DENIED',
    });
  });

  it('allows function calls only as SQL expressions, not as a security boundary', () => {
    expect(validate("SELECT date_trunc('month', created_at) FROM orders").valid).toBe(true);
  });
});
