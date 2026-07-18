import mysql, {
  type Pool,
  type PoolConnection,
  type FieldPacket,
  type RowDataPacket,
} from 'mysql2/promise';
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

function mysqlErrorIdentity(error: unknown): { code?: string; errno?: number } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { code?: unknown; errno?: unknown };
  return {
    ...(value.code !== undefined ? { code: String(value.code) } : {}),
    ...(typeof value.errno === 'number' ? { errno: value.errno } : {}),
  };
}

export class MySqlNativeConnector implements DataSourceConnector {
  readonly id = 'mysql-native';
  private readonly policy = new SqlReadOnlyPolicy();
  private readonly pools = new NativePoolRegistry<Pool>((pool) => pool.end());
  private readonly schemaCache = new Map<string, SchemaCacheValue>();

  constructor(
    private readonly poolFactory: (config: Parameters<typeof mysql.createPool>[0]) => Pool = (
      config
    ) => mysql.createPool(config)
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
      const connection = await this.connectWithAbort(pool, signal);
      try {
        const [rows] = await connection.query<RowDataPacket[][]>(`
          SELECT DATABASE(), VERSION(), @@GLOBAL.read_only, @@GLOBAL.super_read_only,
                 @@version_comment,
                 (SELECT COUNT(*) FROM information_schema.schemata
                   WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys'))
        `);
        const row = rows[0];
        const [sslRows] = await connection.query<RowDataPacket[][]>(
          "SHOW STATUS LIKE 'Ssl_cipher'"
        );
        const tlsActive = Boolean(sslRows[0]?.[1]);
        const version = String(row[1]);
        const majorVersion = Number(version.match(/^(\d+)/)?.[1]);
        const productComment = String(row[4] ?? '');
        if (
          !Number.isInteger(majorVersion) ||
          majorVersion < 8 ||
          /mariadb/i.test(`${version} ${productComment}`)
        ) {
          return {
            status: 'error',
            testedAt: new Date().toISOString(),
            connectionRevision: source.connectionRevision,
            latencyMs: Date.now() - started,
            tlsActive,
            readOnlyAssessment: {
              level: 'unknown',
              reasons: ['MySQL 8.0 or newer is required.'],
              userAcknowledgementRequired: true,
            },
            errorCode: 'SOURCE_UNREACHABLE',
            connectorId: this.id,
            databaseProduct: /mariadb/i.test(`${version} ${productComment}`) ? 'MariaDB' : 'MySQL',
            databaseVersionFamily: Number.isInteger(majorVersion)
              ? version.match(/^(\d+\.\d+)/)?.[1]
              : undefined,
            warnings: ['MySQL 8.0 or newer is required.'],
          };
        }
        const verified = Number(row[3]) === 1;
        const reasons = verified
          ? ['The MySQL server reports super_read_only enabled.']
          : [
              'WorkX cannot prove that every inherited privilege, function, or temporary-table path is read-only.',
            ];
        return {
          status: 'reachable',
          testedAt: new Date().toISOString(),
          connectionRevision: source.connectionRevision,
          latencyMs: Date.now() - started,
          tlsActive,
          readOnlyAssessment: {
            level: verified ? 'verified' : 'warning',
            reasons,
            userAcknowledgementRequired: !verified,
          },
          connectorId: this.id,
          databaseProduct: 'MySQL',
          databaseVersionFamily: version.match(/^(\d+\.\d+)/)?.[1],
          currentDatabase: String(row[0]),
          visibleNamespaceCount: Number(row[5]),
          warnings: verified ? [] : reasons,
        };
      } finally {
        connection.release();
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
    const connection = await this.connectWithAbort(pool, signal);
    try {
      const description =
        request.scope === 'catalog'
          ? await this.describeCatalog(connection, source, request, search)
          : await this.describeObjects(connection, source, request);
      this.schemaCache.set(key, {
        description,
        expiresAt: Date.now() + 10 * 60_000,
      });
      return structuredClone(description);
    } catch (error) {
      throw asDataSourceError(error, 'SCHEMA_NOT_FOUND');
    } finally {
      connection.release();
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
    const connection = await this.connectWithAbort(pool, signal);
    const started = Date.now();
    const timeout = clampTimeout(source);
    let destroyed = false;
    let wallTimedOut = false;
    let priorTimeout = 0;
    let timeoutChanged = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      connection.destroy();
    };
    const onAbort = (): void => destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    const wallTimer = setTimeout(() => {
      wallTimedOut = true;
      destroy();
    }, timeout + 1_000);
    try {
      const [timeoutRows] = await connection.query<RowDataPacket[][]>(
        'SELECT @@SESSION.MAX_EXECUTION_TIME'
      );
      priorTimeout = Number(timeoutRows[0]?.[0] ?? 0);
      await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${timeout}`);
      timeoutChanged = true;
      await connection.query('START TRANSACTION READ ONLY');
      const sql = `SELECT * FROM (${validation.safeSql}) AS workx_limited_result LIMIT ${source.policy.maxRows + 1}`;
      const [rows, fields] = await connection.execute<RowDataPacket[][]>(
        sql,
        encodeDataQueryParameters(request.parameters)
      );
      const columns = (fields as FieldPacket[]).map((field) => ({
        name: field.name,
        databaseType: String(field.columnType),
        normalizedType: normalizeColumnType(String(field.columnType), 'mysql'),
      }));
      return {
        sourceId: source.id,
        sourceName: source.name,
        shape: 'tabular',
        columns,
        rows: rows as unknown[][],
        rowCount: rows.length,
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
      const identity = mysqlErrorIdentity(error);
      if (identity.code === 'ER_QUERY_TIMEOUT' || identity.errno === 3024) {
        throw new DataSourceError('QUERY_TIMEOUT', 'Query timed out.', true);
      }
      if (
        ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_DB_ERROR'].includes(
          identity.code ?? ''
        ) ||
        [1049, 1054, 1146].includes(identity.errno ?? -1)
      ) {
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
          await connection.query('ROLLBACK');
          if (timeoutChanged)
            await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(0, priorTimeout)}`);
          connection.release();
        } catch {
          connection.destroy();
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

  private createPool(source: DataSource, secret: DataSourceSecret, connectionLimit = 2): Pool {
    const tls = source.connection.tls;
    return this.poolFactory({
      host: source.connection.host,
      port: source.connection.port,
      database: source.connection.database,
      user: source.connection.username,
      password: secret.password,
      connectionLimit,
      maxIdle: 0,
      idleTimeout: 60_000,
      connectTimeout: 5_000,
      waitForConnections: true,
      queueLimit: 4,
      multipleStatements: false,
      rowsAsArray: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      ssl:
        tls.mode === 'disable'
          ? undefined
          : {
              rejectUnauthorized: tls.mode === 'verify-full',
              ...(tls.caPem ? { ca: tls.caPem } : {}),
            },
    });
  }

  private getPool(source: DataSource, secret: DataSourceSecret): Promise<Pool> {
    return this.pools.getOrCreate(source.id, source.connectionRevision, async () =>
      this.createPool(source, secret)
    );
  }

  private async connectWithAbort(pool: Pool, signal?: AbortSignal): Promise<PoolConnection> {
    if (signal?.aborted) throw new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.');
    return new Promise((resolve, reject) => {
      const onAbort = (): void =>
        reject(new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      pool.getConnection().then(
        (connection) => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) {
            connection.destroy();
            reject(new DataSourceError('QUERY_CANCELLED', 'Operation was cancelled.'));
          } else resolve(connection);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private async describeCatalog(
    connection: PoolConnection,
    source: DataSource,
    request: DataDescribeRequest,
    search: string
  ): Promise<DataSourceDescription> {
    const offset = decodeCursor(request.cursor, search);
    const [rows] = await connection.execute<RowDataPacket[][]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
          AND (? = '' OR TABLE_SCHEMA LIKE CONCAT('%', ?, '%') OR TABLE_NAME LIKE CONCAT('%', ?, '%'))
          AND (JSON_LENGTH(?) = 0 OR JSON_CONTAINS(?, JSON_QUOTE(TABLE_SCHEMA)))
          AND (JSON_LENGTH(?) = 0 OR JSON_CONTAINS(?, JSON_QUOTE(CONCAT(TABLE_SCHEMA, '.', TABLE_NAME))))
        ORDER BY LOWER(TABLE_SCHEMA), LOWER(TABLE_NAME)
        LIMIT 101 OFFSET ?`,
      [
        search,
        search,
        search,
        JSON.stringify(source.policy.allowedNamespaces),
        JSON.stringify(source.policy.allowedNamespaces),
        JSON.stringify(source.policy.allowedObjects),
        JSON.stringify(source.policy.allowedObjects),
        offset,
      ]
    );
    const hasNext = rows.length > 100;
    const objects: DataObjectRef[] = rows
      .filter((row) => isDataObjectAllowed(source, String(row[0]), String(row[1])))
      .slice(0, 100)
      .map((row) => ({
        namespace: String(row[0]),
        name: String(row[1]),
        qualifiedName: `${String(row[0])}.${String(row[1])}`,
        kind: String(row[2]).includes('VIEW') ? 'view' : 'table',
        ...(row[3] ? { comment: String(row[3]) } : {}),
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
    connection: PoolConnection,
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
    const requestedJson = JSON.stringify(requested);
    const [columns] = await connection.execute<RowDataPacket[][]>(
      `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, t.TABLE_COMMENT,
              c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              c.COLUMN_COMMENT, c.COLUMN_KEY
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
        WHERE JSON_CONTAINS(?, JSON_QUOTE(CONCAT(c.TABLE_SCHEMA, '.', c.TABLE_NAME)))
        ORDER BY LOWER(c.TABLE_SCHEMA), LOWER(c.TABLE_NAME), c.ORDINAL_POSITION`,
      [requestedJson]
    );
    const [relations] = await connection.execute<RowDataPacket[][]>(
      `SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME,
              k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              k.CONSTRAINT_NAME, k.ORDINAL_POSITION
         FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
          AND JSON_CONTAINS(?, JSON_QUOTE(CONCAT(k.TABLE_SCHEMA, '.', k.TABLE_NAME)))
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [requestedJson]
    );
    const grouped = new Map<string, DataObjectDescription>();
    for (const row of columns) {
      if (!isDataObjectAllowed(source, String(row[0]), String(row[1]))) continue;
      const qualifiedName = `${String(row[0])}.${String(row[1])}`;
      let object = grouped.get(qualifiedName);
      if (!object) {
        object = {
          namespace: String(row[0]),
          name: String(row[1]),
          qualifiedName,
          kind: String(row[2]).includes('VIEW') ? 'view' : 'table',
          ...(row[3] ? { comment: String(row[3]) } : {}),
          fields: [],
          relationships: [],
          contextFacts: [],
        };
        grouped.set(qualifiedName, object);
      }
      object.fields.push({
        name: String(row[4]),
        databaseType: String(row[5]),
        nullable: String(row[6]) === 'YES',
        ...(row[7] === null ? {} : { defaultExpression: String(row[7]) }),
        ...(row[8] ? { comment: String(row[8]) } : {}),
        primaryKey: String(row[9]) === 'PRI',
      });
    }
    const relationGroups = new Map<
      string,
      { from: string; to: string; fromFields: string[]; toFields: string[] }
    >();
    for (const row of relations) {
      if (!isDataObjectAllowed(source, String(row[3]), String(row[4]))) continue;
      const key = `${String(row[0])}.${String(row[1])}:${String(row[6])}`;
      const group = relationGroups.get(key) ?? {
        from: `${String(row[0])}.${String(row[1])}`,
        to: `${String(row[3])}.${String(row[4])}`,
        fromFields: [],
        toFields: [],
      };
      group.fromFields.push(String(row[2]));
      group.toFields.push(String(row[5]));
      relationGroups.set(key, group);
    }
    for (const group of relationGroups.values()) {
      grouped.get(group.from)?.relationships.push({
        from: { object: group.from, fields: group.fromFields },
        to: { object: group.to, fields: group.toFields },
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
