import { describe, expect, it, vi } from 'vitest';
import { PostgresNativeConnector } from '../PostgresNativeConnector';
import { MySqlNativeConnector } from '../MySqlNativeConnector';
import { sourceFixture } from '@/core/data-sources/__tests__/fixtures';

describe('PostgresNativeConnector driver enforcement', () => {
  it('tests a disposable connection and reports the verified read-only posture', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          database: 'sales',
          version: 'PostgreSQL 16.3',
          transaction_read_only: 'on',
          can_create: false,
          can_temp: false,
          tls_active: true,
          namespace_count: '4',
        },
      ],
    });
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }), end, on: vi.fn() };
    const connector = new PostgresNativeConnector(() => pool as never);
    const result = await connector.testConnection(sourceFixture(), { password: 'secret' });
    expect(result).toMatchObject({
      status: 'reachable',
      databaseProduct: 'PostgreSQL',
      databaseVersionFamily: '16',
      currentDatabase: 'sales',
      visibleNamespaceCount: 4,
      readOnlyAssessment: { level: 'verified', userAcknowledgementRequired: false },
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported PostgreSQL server versions', async () => {
    const pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              database: 'sales',
              version: 'PostgreSQL 11.22',
              transaction_read_only: 'on',
              can_create: false,
              can_temp: false,
              tls_active: true,
              namespace_count: '1',
            },
          ],
        }),
        release: vi.fn(),
      }),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    const result = await new PostgresNativeConnector(() => pool as never).testConnection(
      sourceFixture(),
      { password: 'secret' }
    );
    expect(result).toMatchObject({
      status: 'error',
      errorCode: 'SOURCE_UNREACHABLE',
      databaseProduct: 'PostgreSQL',
      databaseVersionFamily: '11',
      warnings: ['PostgreSQL 12 or newer is required.'],
    });
  });

  it('uses one array-mode analytical statement inside a bounded read-only transaction', async () => {
    const release = vi.fn();
    const query = vi.fn(async (input: unknown) => {
      if (typeof input === 'object') {
        return {
          rows: [[123, 'paid']],
          fields: [
            { name: 'total', dataTypeID: 23 },
            { name: 'status', dataTypeID: 25 },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], fields: [], rowCount: 0 };
    });
    const client = { query, release };
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      end,
      on: vi.fn(),
    };
    const configs: unknown[] = [];
    const connector = new PostgresNativeConnector((config) => {
      configs.push(config);
      return pool as never;
    });
    const source = sourceFixture({
      policy: { ...sourceFixture().policy, maxRows: 10, timeoutMs: 2_500 },
    });
    const request = {
      source_id: source.id,
      query_language: 'sql' as const,
      query: 'SELECT sum(amt) AS total, $1::text AS status FROM orders',
      parameters: [{ type: 'string' as const, value: 'paid' }],
      purpose: 'Unit query',
    };

    const result = await connector.query(source, { password: 'secret' }, request);
    expect(result.rows).toEqual([[123, 'paid']]);
    expect(result.columns).toEqual([
      { name: 'total', databaseType: '23', normalizedType: 'number' },
      { name: 'status', databaseType: '25', normalizedType: 'string' },
    ]);
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 2500',
      'SET LOCAL lock_timeout = 2500',
      'SET LOCAL idle_in_transaction_session_timeout = 4500',
      expect.objectContaining({
        text: expect.stringContaining('workx_limited_result LIMIT 11'),
        values: ['paid'],
        rowMode: 'array',
      }),
      'ROLLBACK',
    ]);
    expect(query.mock.calls.filter((call) => typeof call[0] === 'object')).toHaveLength(1);
    expect(release).toHaveBeenCalledWith();
    expect(configs[0]).toMatchObject({
      password: 'secret',
      max: 2,
      application_name: 'workx-data-analysis',
      ssl: { rejectUnauthorized: true },
    });

    await connector.query(source, { password: 'secret' }, request);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(configs).toHaveLength(1);
    await connector.invalidateSource(source.id);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('denies write SQL before creating a pool', async () => {
    const factory = vi.fn();
    const connector = new PostgresNativeConnector(factory as never);
    const source = sourceFixture();
    await expect(
      connector.query(
        source,
        { password: 'secret' },
        {
          source_id: source.id,
          query_language: 'sql',
          query: 'DELETE FROM orders',
          purpose: 'Must not execute',
        }
      )
    ).rejects.toMatchObject({ code: 'QUERY_NOT_READ_ONLY' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps server statement cancellation to a retryable query timeout', async () => {
    const query = vi.fn(async (input: unknown) => {
      if (typeof input === 'object') throw Object.assign(new Error('cancelled'), { code: '57014' });
      return { rows: [], fields: [], rowCount: 0 };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
      end: vi.fn(),
      on: vi.fn(),
    };
    const connector = new PostgresNativeConnector(() => pool as never);
    await expect(
      connector.query(
        sourceFixture(),
        { password: 'secret' },
        {
          source_id: sourceFixture().id,
          query_language: 'sql',
          query: 'SELECT pg_sleep(30)',
          purpose: 'Timeout mapping',
        }
      )
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
    expect(release).toHaveBeenCalledWith();
  });

  it('maps missing PostgreSQL schema to a refreshable error and clears schema cache', async () => {
    const query = vi.fn(async (input: unknown) => {
      if (typeof input === 'object') {
        throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      }
      return { rows: [], fields: [], rowCount: 0 };
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      end: vi.fn(),
      on: vi.fn(),
    };
    const connector = new PostgresNativeConnector(() => pool as never);
    const invalidate = vi.spyOn(connector, 'invalidateSchema');
    await expect(
      connector.query(
        sourceFixture(),
        { password: 'secret' },
        {
          source_id: sourceFixture().id,
          query_language: 'sql',
          query: 'SELECT * FROM missing_table',
          purpose: 'Schema refresh mapping',
        }
      )
    ).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' });
    expect(invalidate).toHaveBeenCalledWith(sourceFixture().id);
  });

  it('cancels an active query by destroying its checked-out client', async () => {
    let rejectAnalytical: (error: Error) => void = () => undefined;
    const release = vi.fn((destroy?: boolean) => {
      if (destroy) rejectAnalytical(new Error('connection destroyed'));
    });
    const query = vi.fn((input: unknown) => {
      if (typeof input === 'object') {
        return new Promise((_resolve, reject) => {
          rejectAnalytical = reject;
        });
      }
      return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
      end: vi.fn(),
      on: vi.fn(),
    };
    const connector = new PostgresNativeConnector(() => pool as never);
    const source = sourceFixture();
    const controller = new AbortController();
    const pending = connector.query(
      source,
      { password: 'secret' },
      {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT pg_sleep(10)',
        purpose: 'Cancellation',
      },
      controller.signal
    );
    await vi.waitFor(() =>
      expect(query.mock.calls.some((call) => typeof call[0] === 'object')).toBe(true)
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    expect(release).toHaveBeenCalledWith(true);
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('caches schema reads without closing the query pool and refreshes only schema cache', async () => {
    const release = vi.fn();
    const query = vi.fn().mockResolvedValue({
      rows: [{ namespace: 'public', name: 'orders', kind: 'table', comment: null }],
    });
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
      on: vi.fn(),
    };
    const connector = new PostgresNativeConnector(() => pool as never);
    const source = sourceFixture();
    const request = { source_id: source.id, scope: 'catalog' as const };
    await connector.describe(source, { password: 'secret' }, request);
    await connector.describe(source, { password: 'secret' }, request);
    expect(query).toHaveBeenCalledTimes(1);
    connector.invalidateSchema(source.id);
    expect(end).not.toHaveBeenCalled();
    await connector.describe(source, { password: 'secret' }, request);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('MySqlNativeConnector driver enforcement', () => {
  it('tests a disposable connection and reports server and TLS metadata', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[['sales', '8.0.37', 1, 1, 'MySQL Community Server', 3]], []])
      .mockResolvedValueOnce([[['Ssl_cipher', 'TLS_AES_256_GCM_SHA384']], []]);
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      getConnection: vi.fn().mockResolvedValue({ query, release }),
      end,
    };
    const connector = new MySqlNativeConnector(() => pool as never);
    const result = await connector.testConnection(sourceFixture({}, 'mysql-native'), {
      password: 'secret',
    });
    expect(result).toMatchObject({
      status: 'reachable',
      databaseProduct: 'MySQL',
      databaseVersionFamily: '8.0',
      currentDatabase: 'sales',
      visibleNamespaceCount: 3,
      tlsActive: true,
      readOnlyAssessment: { level: 'verified', userAcknowledgementRequired: false },
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('rejects MariaDB even when its compatibility version starts with 10', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[['sales', '10.11.8-MariaDB', 1, 1, 'MariaDB Server', 3]], []])
      .mockResolvedValueOnce([[['Ssl_cipher', 'TLS_AES_256_GCM_SHA384']], []]);
    const pool = {
      getConnection: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const result = await new MySqlNativeConnector(() => pool as never).testConnection(
      sourceFixture({}, 'mysql-native'),
      { password: 'secret' }
    );
    expect(result).toMatchObject({
      status: 'error',
      errorCode: 'SOURCE_UNREACHABLE',
      databaseProduct: 'MariaDB',
      databaseVersionFamily: '10.11',
      warnings: ['MySQL 8.0 or newer is required.'],
    });
  });

  it('uses one prepared analytical statement and restores session timeout after rollback', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT @@SESSION.MAX_EXECUTION_TIME') return [[[8000]], []];
      return [[], []];
    });
    const execute = vi.fn().mockResolvedValue([
      [[123, 'paid']],
      [
        { name: 'total', columnType: 3 },
        { name: 'status', columnType: 253 },
      ],
    ]);
    const release = vi.fn();
    const destroy = vi.fn();
    const connection = { query, execute, release, destroy };
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), end };
    const configs: unknown[] = [];
    const connector = new MySqlNativeConnector((config) => {
      configs.push(config);
      return pool as never;
    });
    const source = sourceFixture(
      { policy: { ...sourceFixture().policy, maxRows: 10, timeoutMs: 2_500 } },
      'mysql-native'
    );
    const result = await connector.query(
      source,
      { password: 'secret' },
      {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT sum(amt) AS total, ? AS status FROM orders',
        parameters: [{ type: 'string', value: 'paid' }],
        purpose: 'Unit query',
      }
    );
    expect(result.rows).toEqual([[123, 'paid']]);
    expect(result.columns).toEqual([
      { name: 'total', databaseType: '3', normalizedType: 'number' },
      { name: 'status', databaseType: '253', normalizedType: 'string' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('workx_limited_result LIMIT 11'), [
      'paid',
    ]);
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'SELECT @@SESSION.MAX_EXECUTION_TIME',
      'SET SESSION MAX_EXECUTION_TIME = 2500',
      'START TRANSACTION READ ONLY',
      'ROLLBACK',
      'SET SESSION MAX_EXECUTION_TIME = 8000',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(configs[0]).toMatchObject({
      password: 'secret',
      connectionLimit: 2,
      multipleStatements: false,
      rowsAsArray: true,
    });
    await connector.dispose();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('destroys an uncertain connection if cleanup fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT @@SESSION.MAX_EXECUTION_TIME') return [[[0]], []];
      if (sql === 'ROLLBACK') throw new Error('connection lost during rollback');
      return [[], []];
    });
    const execute = vi.fn().mockResolvedValue([[[1]], [{ name: 'value', columnType: 3 }]]);
    const connection = { query, execute, release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), end: vi.fn() };
    const connector = new MySqlNativeConnector(() => pool as never);
    const source = sourceFixture({}, 'mysql-native');
    await connector.query(
      source,
      { password: 'secret' },
      {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT 1 AS value',
        purpose: 'Cleanup failure',
      }
    );
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('cancels an active query by destroying its checked-out connection', async () => {
    let rejectExecute: (error: Error) => void = () => undefined;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT @@SESSION.MAX_EXECUTION_TIME') return [[[0]], []];
      return [[], []];
    });
    const execute = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectExecute = reject;
        })
    );
    const destroy = vi.fn(() => rejectExecute(new Error('connection destroyed')));
    const connection = { query, execute, release: vi.fn(), destroy };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), end: vi.fn() };
    const connector = new MySqlNativeConnector(() => pool as never);
    const source = sourceFixture({}, 'mysql-native');
    const controller = new AbortController();
    const pending = connector.query(
      source,
      { password: 'secret' },
      {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT SLEEP(10)',
        purpose: 'Cancellation',
      },
      controller.signal
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('denies multiple statements before acquiring a connection', async () => {
    const factory = vi.fn();
    const connector = new MySqlNativeConnector(factory as never);
    const source = sourceFixture({}, 'mysql-native');
    await expect(
      connector.query(
        source,
        { password: 'secret' },
        {
          source_id: source.id,
          query_language: 'sql',
          query: 'SELECT 1; SELECT 2',
          purpose: 'Must not execute',
        }
      )
    ).rejects.toMatchObject({ code: 'QUERY_MULTIPLE_STATEMENTS' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps MAX_EXECUTION_TIME failures to a retryable query timeout', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT @@SESSION.MAX_EXECUTION_TIME') return [[[0]], []];
      return [[], []];
    });
    const execute = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('query timeout'), { code: 'ER_QUERY_TIMEOUT' }));
    const connection = { query, execute, release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), end: vi.fn() };
    const connector = new MySqlNativeConnector(() => pool as never);
    await expect(
      connector.query(
        sourceFixture({}, 'mysql-native'),
        { password: 'secret' },
        {
          source_id: sourceFixture().id,
          query_language: 'sql',
          query: 'SELECT SLEEP(30)',
          purpose: 'Timeout mapping',
        }
      )
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('maps missing MySQL schema to a refreshable error and clears schema cache', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT @@SESSION.MAX_EXECUTION_TIME') return [[[0]], []];
      return [[], []];
    });
    const execute = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('table does not exist'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      );
    const connection = { query, execute, release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), end: vi.fn() };
    const connector = new MySqlNativeConnector(() => pool as never);
    const invalidate = vi.spyOn(connector, 'invalidateSchema');
    await expect(
      connector.query(
        sourceFixture({}, 'mysql-native'),
        { password: 'secret' },
        {
          source_id: sourceFixture().id,
          query_language: 'sql',
          query: 'SELECT * FROM missing_table',
          purpose: 'Schema refresh mapping',
        }
      )
    ).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' });
    expect(invalidate).toHaveBeenCalledWith(sourceFixture().id);
  });

  it('caches schema reads and invalidates schema without closing its pool', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([[['sales', 'orders', 'BASE TABLE', 'Order facts']], []]);
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      getConnection: vi.fn().mockResolvedValue({ execute, release }),
      end,
    };
    const connector = new MySqlNativeConnector(() => pool as never);
    const source = sourceFixture({}, 'mysql-native');
    const request = { source_id: source.id, scope: 'catalog' as const };
    const first = await connector.describe(source, { password: 'secret' }, request);
    await connector.describe(source, { password: 'secret' }, request);
    expect(first.objects[0]).toMatchObject({
      namespace: 'sales',
      name: 'orders',
      kind: 'table',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    connector.invalidateSchema(source.id);
    expect(end).not.toHaveBeenCalled();
    await connector.describe(source, { password: 'secret' }, request);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
