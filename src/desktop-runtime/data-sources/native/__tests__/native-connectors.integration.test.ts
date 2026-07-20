import { describe, expect, it, vi } from 'vitest';
import { NativePoolRegistry } from '../NativePoolRegistry';
import {
  decodeCursor,
  encodeCursor,
  normalizeColumnType,
  queryHash,
  schemaFingerprint,
  isDataObjectAllowed,
  splitQualifiedObject,
} from '../nativeUtils';
import { PostgresNativeConnector } from '../PostgresNativeConnector';
import { MySqlNativeConnector } from '../MySqlNativeConnector';
import { sourceFixture } from '@/core/data-sources/__tests__/fixtures';
import type { DataSource, DataSourceSecret } from '@/core/data-sources';

describe('native connector shared infrastructure', () => {
  it('reuses pools by source/revision and closes stale/invalidate/dispose entries', async () => {
    const closed: string[] = [];
    const pools = new NativePoolRegistry<{ id: string }>(async (pool) => {
      closed.push(pool.id);
    });
    let creates = 0;
    const factory = async () => ({ id: `pool-${++creates}` });
    const first = await pools.getOrCreate('source-a', 1, factory);
    expect(await pools.getOrCreate('source-a', 1, factory)).toBe(first);
    const replacement = await pools.getOrCreate('source-a', 2, factory);
    expect(replacement).not.toBe(first);
    expect(closed).toEqual(['pool-1']);
    await pools.getOrCreate('source-b', 1, factory);
    await pools.invalidate('source-a');
    expect(closed).toContain('pool-2');
    await pools.dispose();
    expect(closed).toContain('pool-3');
  });

  it('serializes concurrent creation and cannot leak a pool across invalidation', async () => {
    const closed: string[] = [];
    const pools = new NativePoolRegistry<{ id: string }>(async (pool) => {
      closed.push(pool.id);
    });
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const factory = vi.fn(async () => {
      await factoryGate;
      return { id: 'shared' };
    });
    const first = pools.getOrCreate('source-a', 1, factory);
    const second = pools.getOrCreate('source-a', 1, factory);
    const invalidation = pools.invalidate('source-a');
    releaseFactory();
    expect(await first).toEqual({ id: 'shared' });
    expect(await second).toEqual({ id: 'shared' });
    await invalidation;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(closed).toEqual(['shared']);
  });

  it('uses bound cursors, stable hashes/fingerprints, and normalized portable types', () => {
    const cursor = encodeCursor(100, 'Paid');
    expect(decodeCursor(cursor, 'paid')).toBe(100);
    expect(() => decodeCursor(cursor, 'other')).toThrow();
    expect(queryHash('postgres-native', 'SELECT 1')).toMatch(/^[a-f0-9]{64}$/);
    expect(
      schemaFingerprint([
        { namespace: 'public', name: 'orders', qualifiedName: 'public.orders', kind: 'table' },
      ])
    ).toBe(
      schemaFingerprint([
        { namespace: 'public', name: 'orders', qualifiedName: 'public.orders', kind: 'table' },
      ])
    );
    expect(normalizeColumnType('BOOLEAN')).toBe('boolean');
    expect(normalizeColumnType('numeric(12,2)')).toBe('number');
    expect(normalizeColumnType('timestamp with time zone')).toBe('date');
    expect(normalizeColumnType('jsonb')).toBe('json');
    expect(normalizeColumnType('BLOB')).toBe('binary-omitted');
    expect(normalizeColumnType('23', 'postgresql')).toBe('number');
    expect(normalizeColumnType('16', 'postgresql')).toBe('boolean');
    expect(normalizeColumnType('3', 'mysql')).toBe('number');
    expect(normalizeColumnType('245', 'mysql')).toBe('json');
    const restricted = sourceFixture({
      policy: {
        ...sourceFixture().policy,
        allowedNamespaces: ['public'],
        allowedObjects: ['public.orders'],
      },
    });
    expect(isDataObjectAllowed(restricted, 'PUBLIC', 'Orders')).toBe(true);
    expect(isDataObjectAllowed(restricted, 'private', 'orders')).toBe(false);
    expect(isDataObjectAllowed(restricted, 'public', 'customers')).toBe(false);
    expect(splitQualifiedObject('public.orders')).toEqual({
      namespace: 'public',
      name: 'orders',
    });
  });
});

function sourceFromUrl(
  raw: string,
  connectorId: DataSource['connectorId']
): {
  source: DataSource;
  secret: DataSourceSecret;
} {
  const url = new URL(raw);
  const tlsMode = (url.searchParams.get('workxTls') ?? 'disable') as
    | 'disable'
    | 'require'
    | 'verify-full';
  const source = sourceFixture(
    {
      connectorId,
      connection: {
        host: url.hostname,
        port: Number(url.port || (connectorId === 'postgres-native' ? 5432 : 3306)),
        database: url.pathname.replace(/^\//, ''),
        username: decodeURIComponent(url.username),
        tls: { mode: tlsMode },
      },
      policy: {
        ...sourceFixture().policy,
        maxRows: 20,
        timeoutMs: 2_000,
      },
    },
    connectorId
  );
  return { source, secret: { password: decodeURIComponent(url.password) } };
}

const postgresUrl = process.env.WORKX_TEST_POSTGRES_URL;
describe.runIf(Boolean(postgresUrl))(
  'PostgreSQL native connector (opt-in disposable database)',
  () => {
    it('tests, describes, parameterizes, cancels, reuses, invalidates, and shuts down', async () => {
      const connector = new PostgresNativeConnector();
      const { source, secret } = sourceFromUrl(postgresUrl!, 'postgres-native');
      const test = await connector.testConnection(source, secret);
      expect(test.status).toBe('reachable');
      const catalog = await connector.describe(source, secret, {
        source_id: source.id,
        scope: 'catalog',
      });
      expect(catalog.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const first = await connector.query(source, secret, {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT $1::int AS value',
        parameters: [{ type: 'number', value: 7 }],
        purpose: 'Connector integration',
      });
      expect(first.rows?.[0]?.[0]).toBe(7);
      await expect(
        connector.query(source, secret, {
          source_id: source.id,
          query_language: 'sql',
          query: 'DELETE FROM information_schema.tables',
          purpose: 'Must fail before execution',
        })
      ).rejects.toMatchObject({ code: 'QUERY_NOT_READ_ONLY' });
      const controller = new AbortController();
      const sleeping = connector.query(
        source,
        secret,
        {
          source_id: source.id,
          query_language: 'sql',
          query: 'SELECT pg_sleep(10)',
          purpose: 'Cancellation integration',
        },
        controller.signal
      );
      setTimeout(() => controller.abort(), 50);
      await expect(sleeping).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
      await connector.invalidateSource(source.id);
      await connector.dispose();
    }, 20_000);
  }
);

const mysqlUrl = process.env.WORKX_TEST_MYSQL_URL;
describe.runIf(Boolean(mysqlUrl))('MySQL native connector (opt-in disposable database)', () => {
  it('tests, describes, parameterizes, cancels, reuses, invalidates, and shuts down', async () => {
    const connector = new MySqlNativeConnector();
    const { source, secret } = sourceFromUrl(mysqlUrl!, 'mysql-native');
    const test = await connector.testConnection(source, secret);
    expect(test.status).toBe('reachable');
    const catalog = await connector.describe(source, secret, {
      source_id: source.id,
      scope: 'catalog',
    });
    expect(catalog.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const first = await connector.query(source, secret, {
      source_id: source.id,
      query_language: 'sql',
      query: 'SELECT CAST(? AS SIGNED) AS value',
      parameters: [{ type: 'number', value: 7 }],
      purpose: 'Connector integration',
    });
    expect(Number(first.rows?.[0]?.[0])).toBe(7);
    await expect(
      connector.query(source, secret, {
        source_id: source.id,
        query_language: 'sql',
        query: "UPDATE information_schema.tables SET table_name = 'x'",
        purpose: 'Must fail before execution',
      })
    ).rejects.toMatchObject({ code: 'QUERY_NOT_READ_ONLY' });
    const controller = new AbortController();
    const sleeping = connector.query(
      source,
      secret,
      {
        source_id: source.id,
        query_language: 'sql',
        query: 'SELECT SLEEP(10)',
        purpose: 'Cancellation integration',
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 50);
    await expect(sleeping).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    await connector.invalidateSource(source.id);
    await connector.dispose();
  }, 20_000);
});
