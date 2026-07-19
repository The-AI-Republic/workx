import pg from 'pg';
import {
  DataSourceError,
  SqlReadOnlyPolicy,
  asDataSourceError,
  encodeDataQueryParameters,
  type DataDescribeRequest,
  type DataObjectDescription,
  type DataObjectRef,
  type DataQueryRequest,
  type DataQueryValidation,
  type DataResult,
  type DataSource,
  type DataSourceCapabilities,
  type DataSourceConnector,
  type DataSourceDescription,
  type DataSourceSecret,
  type DataSourceTestResult,
} from '@/core/data-sources';
import { NativePoolRegistry } from './NativePoolRegistry';
import {
  clampTimeout,
  decodeCursor,
  encodeCursor,
  normalizeColumnType,
  isDataObjectAllowed,
  queryHash,
  schemaFingerprint,
  sourceSchemaCacheKey,
  sourceSummary,
  splitQualifiedObject,
  type SchemaCacheValue,
} from './nativeUtils';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

interface PgCatalogRow {
  namespace: string;
  name: string;
  kind: string;
  comment: string | null;
}

interface PgColumnRow {
  namespace: string;
  object_name: string;
  object_kind: string;
  column_name: string;
  data_type: string;
  nullable: boolean;
  default_expression: string | null;
  comment: string | null;
  primary_key: boolean;
  object_comment: string | null;
}

interface PgRelationRow {
  from_object: string;
  from_fields: string[];
  to_object: string;
  to_fields: string[];
}

function postgresErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

export class PostgresNativeConnector implements DataSourceConnector {
  readonly id = 'postgres-native';
  private readonly policy = new SqlReadOnlyPolicy();
  private readonly pools = new NativePoolRegistry<PgPool>((pool) => pool.end());
  private readonly schemaCache = new Map<string, SchemaCacheValue>();

  constructor(
    private readonly poolFactory: (config: pg.PoolConfig) => PgPool = (config) => new Pool(config)
  ) {}

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
    const started = Date.now();
    const pool = this.createPool(source, secret, 1);
    try {
      const client = await this.connectWithAbort(pool, signal);
      try {
        const result = await client.query<{
          database: string;
          version: string;
          transaction_read_only: string;
          can_create: boolean;
          can_temp: boolean;
          tls_active: boolean | null;
          namespace_count: string;
        }>(`
          SELECT current_database() AS database,
                 version() AS version,
                 current_setting('transaction_read_only') AS transaction_read_only,
                 has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
                 has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp,
                 (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_active,
                 (SELECT count(*)::text FROM information_schema.schemata
                   WHERE schema_name NOT IN ('pg_catalog', 'information_schema')) AS namespace_count
        `);
        const row = result.rows[0];
        const majorVersion = Number(row.version.match(/PostgreSQL\s+(\d+)/)?.[1]);
        if (!Number.isInteger(majorVersion) || majorVersion < 12) {
          return {
            status: 'error',
            testedAt: new Date().toISOString(),
            connectionRevision: source.connectionRevision,
            latencyMs: Date.now() - started,
            readOnlyAssessment: {
              level: 'unknown',
              reasons: ['PostgreSQL 12 or newer is required.'],
              userAcknowledgementRequired: true,
            },
            errorCode: 'SOURCE_UNREACHABLE',
            connectorId: this.id,
            databaseProduct: 'PostgreSQL',
            databaseVersionFamily: Number.isInteger(majorVersion)
              ? String(majorVersion)
              : undefined,
            warnings: ['PostgreSQL 12 or newer is required.'],
          };
        }
        const verified = row.transaction_read_only === 'on' && !row.can_create && !row.can_temp;
        const reasons = verified
          ? ['Session is read-only and the account lacks CREATE/TEMP database privileges.']
          : [
              'WorkX cannot prove that every inherited privilege or database function is read-only.',
            ];
        return {
          status: 'reachable',
          testedAt: new Date().toISOString(),
          connectionRevision: source.connectionRevision,
          latencyMs: Date.now() - started,
          tlsActive: row.tls_active ?? source.connection.tls.mode !== 'disable',
          readOnlyAssessment: {
            level: verified ? 'verified' : 'warning',
            reasons,
            userAcknowledgementRequired: !verified,
          },
          connectorId: this.id,
          databaseProduct: 'PostgreSQL',
          databaseVersionFamily: String(majorVersion),
          currentDatabase: row.database,
          visibleNamespaceCount: Number(row.namespace_count),
          warnings: verified ? [] : reasons,
        };
      } finally {
        client.release();
      }
    } catch (error) {
      const safe = asDataSourceError(error);
      return {
        status: 'error',
        testedAt: new Date().toISOString(),
        connectionRevision: source.connectionRevision,
        latencyMs: Date.now() - started,
        readOnlyAssessment: {
          level: 'unknown',
          reasons: ['Read-only posture could not be assessed because the connection failed.'],
          userAcknowledgementRequired: true,
        },
        errorCode: safe.code,
        connectorId: this.id,
        warnings: [safe.message],
      };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async describe(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataDescribeRequest,
    signal?: AbortSignal
  ): Promise<DataSourceDescription> {
    const search = request.search?.trim() ?? '';
    const key = sourceSchemaCacheKey(source, request.scope, request.objects, search);
    const cached = this.schemaCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.description);
    const pool = await this.getPool(source, secret);
    const client = await this.connectWithAbort(pool, signal);
    try {
      const description =
        request.scope === 'catalog'
          ? await this.describeCatalog(client, source, request, search)
          : await this.describeObjects(client, source, request);
      this.schemaCache.set(key, {
        description,
        expiresAt: Date.now() + 10 * 60_000,
      });
      return structuredClone(description);
    } catch (error) {
      throw asDataSourceError(error, 'SCHEMA_NOT_FOUND');
    } finally {
      client.release();
    }
  }

  validateQuery(source: DataSource, request: DataQueryRequest): DataQueryValidation {
    return this.policy.validate(source, request);
  }

  async query(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataQueryRequest,
    signal?: AbortSignal
  ): Promise<DataResult> {
    const validation = this.policy.validate(source, request);
    if (!validation.valid) throw new DataSourceError(validation.code, validation.message);
    const pool = await this.getPool(source, secret);
    const client = await this.connectWithAbort(pool, signal);
    const started = Date.now();
    const timeout = clampTimeout(source);
    let destroyed = false;
    let wallTimedOut = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      client.release(true);
    };
    const onAbort = (): void => destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    const wallTimer = setTimeout(() => {
      wallTimedOut = true;
      destroy();
    }, timeout + 1_000);
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      await client.query(`SET LOCAL lock_timeout = ${Math.min(timeout, 5_000)}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeout + 2_000}`);
      const text = `SELECT * FROM (${validation.safeSql}) AS workx_limited_result LIMIT ${source.policy.maxRows + 1}`;
      const result = await client.query({
        text,
        values: encodeDataQueryParameters(request.parameters),
        rowMode: 'array',
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        shape: 'tabular',
        columns: result.fields.map((field) => ({
          name: field.name,
          databaseType: String(field.dataTypeID),
          normalizedType: normalizeColumnType(String(field.dataTypeID), 'postgresql'),
        })),
        rows: result.rows as unknown[][],
        rowCount: result.rowCount ?? result.rows.length,
        truncated: false,
        executionMs: Date.now() - started,
        provenance: {
          connectorId: this.id,
          transport: 'native',
          queryLanguage: 'sql',
          queryHash: queryHash(this.id, validation.safeSql),
        },
      };
    } catch (error) {
      if (signal?.aborted) throw new DataSourceError('QUERY_CANCELLED', 'Query was cancelled.');
      if (wallTimedOut) throw new DataSourceError('QUERY_TIMEOUT', 'Query timed out.', true);
      const code = postgresErrorCode(error);
      if (code === '57014') throw new DataSourceError('QUERY_TIMEOUT', 'Query timed out.', true);
      if (['42P01', '42703', '3F000'].includes(code ?? '')) {
        this.invalidateSchema(source.id);
        throw new DataSourceError(
          'SCHEMA_NOT_FOUND',
          'The query references schema that is no longer available.'
        );
      }
      throw asDataSourceError(error, 'SOURCE_UNREACHABLE');
    } finally {
      clearTimeout(wallTimer);
      signal?.removeEventListener('abort', onAbort);
      if (!destroyed) {
        try {
          await client.query('ROLLBACK');
          client.release();
        } catch {
          client.release(true);
        }
      }
    }
  }

  async invalidateSource(sourceId: string): Promise<void> {
    this.invalidateSchema(sourceId);
    await this.pools.invalidate(sourceId);
  }

  invalidateSchema(sourceId: string): void {
    for (const key of [...this.schemaCache.keys()])
      if (key.startsWith(`${sourceId}:`)) this.schemaCache.delete(key);
  }

  async dispose(): Promise<void> {
    this.schemaCache.clear();
    await this.pools.dispose();
  }

  private createPool(source: DataSource, secret: DataSourceSecret, max = 2): PgPool {
    const tls = source.connection.tls;
    const pool = this.poolFactory({
      host: source.connection.host,
      port: source.connection.port,
      database: source.connection.database,
      user: source.connection.username,
      password: secret.password,
      max,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 60_000,
      allowExitOnIdle: true,
      application_name: 'workx-data-analysis',
      ssl:
        tls.mode === 'disable'
          ? false
          : {
              rejectUnauthorized: tls.mode === 'verify-full',
              ...(tls.caPem ? { ca: tls.caPem } : {}),
            },
    });
    pool.on('error', () => undefined);
    return pool;
  }

  private getPool(source: DataSource, secret: DataSourceSecret): Promise<PgPool> {
    return this.pools.getOrCreate(source.id, source.connectionRevision, async () =>
      this.createPool(source, secret)
    );
  }

  private async connectWithAbort(pool: PgPool, signal?: AbortSignal): Promise<pg.PoolClient> {
    if (signal?.aborted) throw new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.');
    return new Promise((resolve, reject) => {
      const onAbort = (): void =>
        reject(new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      pool.connect().then(
        (client) => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) {
            client.release(true);
            reject(new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.'));
          } else resolve(client);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private async describeCatalog(
    client: pg.PoolClient,
    source: DataSource,
    request: DataDescribeRequest,
    search: string
  ): Promise<DataSourceDescription> {
    const offset = decodeCursor(request.cursor, search);
    const result = await client.query<PgCatalogRow>(
      `SELECT n.nspname AS namespace, c.relname AS name,
              CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','f')
          AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND ($1 = '' OR n.nspname ILIKE '%' || $1 || '%' OR c.relname ILIKE '%' || $1 || '%')
          AND (cardinality($2::text[]) = 0 OR n.nspname = ANY($2::text[]))
          AND (cardinality($3::text[]) = 0 OR n.nspname || '.' || c.relname = ANY($3::text[]))
        ORDER BY lower(n.nspname), lower(c.relname), c.oid
        LIMIT 101 OFFSET $4`,
      [search, source.policy.allowedNamespaces, source.policy.allowedObjects, offset]
    );
    const hasNext = result.rows.length > 100;
    const objects: DataObjectRef[] = result.rows
      .filter((row) => isDataObjectAllowed(source, row.namespace, row.name))
      .slice(0, 100)
      .map((row) => ({
        namespace: row.namespace,
        name: row.name,
        qualifiedName: `${row.namespace}.${row.name}`,
        kind: row.kind === 'view' ? 'view' : 'table',
        ...(row.comment ? { comment: row.comment } : {}),
      }));
    return {
      source: sourceSummary(source, this.getCapabilities()),
      scope: 'catalog',
      objects,
      ...(hasNext ? { nextCursor: encodeCursor(offset + 100, search) } : {}),
      schemaFingerprint: schemaFingerprint(objects),
      warnings: [],
    };
  }

  private async describeObjects(
    client: pg.PoolClient,
    source: DataSource,
    request: DataDescribeRequest
  ): Promise<DataSourceDescription> {
    const rawRequested = [...new Set(request.objects ?? [])].slice(0, 20);
    if (!rawRequested.length)
      throw new DataSourceError('SCHEMA_NOT_FOUND', 'At least one qualified object is required.');
    const requested = rawRequested.filter((candidate) => {
      const object = splitQualifiedObject(candidate);
      return object && isDataObjectAllowed(source, object.namespace, object.name);
    });
    if (!requested.length) {
      const objects: DataObjectDescription[] = [];
      return {
        source: sourceSummary(source, this.getCapabilities()),
        scope: 'objects',
        objects,
        schemaFingerprint: schemaFingerprint(objects),
        warnings: ['Requested objects were not visible or allowed.'],
      };
    }
    const columns = await client.query<PgColumnRow>(
      `SELECT n.nspname AS namespace, c.relname AS object_name,
              CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS object_kind,
              a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable, pg_get_expr(ad.adbin, ad.adrelid) AS default_expression,
              col_description(c.oid, a.attnum) AS comment, obj_description(c.oid, 'pg_class') AS object_comment,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
        WHERE n.nspname || '.' || c.relname = ANY($1::text[])
        ORDER BY lower(n.nspname), lower(c.relname), a.attnum`,
      [requested]
    );
    const relations = await client.query<PgRelationRow>(
      `SELECT n1.nspname || '.' || c1.relname AS from_object,
              array_agg(a1.attname ORDER BY x.ord) AS from_fields,
              n2.nspname || '.' || c2.relname AS to_object,
              array_agg(a2.attname ORDER BY x.ord) AS to_fields
         FROM pg_constraint con
         JOIN pg_class c1 ON c1.oid=con.conrelid JOIN pg_namespace n1 ON n1.oid=c1.relnamespace
         JOIN pg_class c2 ON c2.oid=con.confrelid JOIN pg_namespace n2 ON n2.oid=c2.relnamespace
         JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY x(from_att, to_att, ord) ON true
         JOIN pg_attribute a1 ON a1.attrelid=c1.oid AND a1.attnum=x.from_att
         JOIN pg_attribute a2 ON a2.attrelid=c2.oid AND a2.attnum=x.to_att
        WHERE con.contype='f' AND n1.nspname || '.' || c1.relname = ANY($1::text[])
        GROUP BY n1.nspname,c1.relname,n2.nspname,c2.relname`,
      [requested]
    );
    const grouped = new Map<string, DataObjectDescription>();
    for (const row of columns.rows) {
      if (!isDataObjectAllowed(source, row.namespace, row.object_name)) continue;
      const qualifiedName = `${row.namespace}.${row.object_name}`;
      let object = grouped.get(qualifiedName);
      if (!object) {
        object = {
          namespace: row.namespace,
          name: row.object_name,
          qualifiedName,
          kind: row.object_kind === 'view' ? 'view' : 'table',
          ...(row.object_comment ? { comment: row.object_comment } : {}),
          fields: [],
          relationships: [],
          contextFacts: [],
        };
        grouped.set(qualifiedName, object);
      }
      object.fields.push({
        name: row.column_name,
        databaseType: row.data_type,
        nullable: row.nullable,
        ...(row.default_expression ? { defaultExpression: row.default_expression } : {}),
        ...(row.comment ? { comment: row.comment } : {}),
        primaryKey: row.primary_key,
      });
    }
    for (const relation of relations.rows) {
      const target = splitQualifiedObject(relation.to_object);
      if (!target || !isDataObjectAllowed(source, target.namespace, target.name)) continue;
      grouped.get(relation.from_object)?.relationships.push({
        from: { object: relation.from_object, fields: relation.from_fields },
        to: { object: relation.to_object, fields: relation.to_fields },
      });
    }
    const objects = [...grouped.values()];
    return {
      source: sourceSummary(source, this.getCapabilities()),
      scope: 'objects',
      objects,
      schemaFingerprint: schemaFingerprint(objects),
      warnings:
        objects.length < rawRequested.length
          ? ['Some requested objects were not visible or allowed.']
          : [],
    };
  }
}
