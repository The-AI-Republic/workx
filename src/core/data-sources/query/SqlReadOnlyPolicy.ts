import mysqlParserPackage from 'node-sql-parser/build/mysql';
import postgresParserPackage from 'node-sql-parser/build/postgresql';
import type { DataQueryRequest, DataQueryValidation, DataSource } from '../types';

const { Parser: MySqlParser } = mysqlParserPackage as unknown as typeof import('node-sql-parser');
const { Parser: PostgresParser } =
  postgresParserPackage as unknown as typeof import('node-sql-parser');
type ParserInstance = InstanceType<typeof MySqlParser>;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function walk(
  value: unknown,
  visit: (node: UnknownRecord) => void,
  seen = new Set<unknown>()
): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  const node = value as UnknownRecord;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit, seen);
}

function normalizedObject(value: string): string {
  return value
    .split('.')
    .map((part) => part.replace(/^[`"]|[`"]$/g, '').toLocaleLowerCase('en-US'))
    .join('.');
}

function referencedObjects(
  parser: ParserInstance,
  sql: string,
  database: string,
  ast: UnknownRecord
): string[] {
  const cteNames = new Set<string>();
  const withItems = Array.isArray(ast.with) ? ast.with : [];
  for (const item of withItems) {
    if (isRecord(item) && isRecord(item.name) && typeof item.name.value === 'string') {
      cteNames.add(normalizedObject(item.name.value));
    }
  }
  return parser
    .tableList(sql, { database })
    .map((entry) => {
      const [, namespace, table] = entry.split('::');
      return normalizedObject(namespace && namespace !== 'null' ? `${namespace}.${table}` : table);
    })
    .filter((entry) => !cteNames.has(entry));
}

export class SqlReadOnlyPolicy {
  private readonly parsers = {
    mysql: new MySqlParser(),
    postgresql: new PostgresParser(),
  };

  validate(source: DataSource, request: DataQueryRequest): DataQueryValidation {
    const dialect = source.connectorId === 'postgres-native' ? 'postgresql' : 'mysql';
    const parser = this.parsers[dialect];
    const database = dialect === 'postgresql' ? 'Postgresql' : 'MySQL';
    let ast: unknown;
    try {
      ast = parser.astify(request.query, { database });
    } catch {
      return {
        valid: false,
        code: 'QUERY_PARSE_FAILED',
        message: 'SQL could not be parsed for this source.',
      };
    }
    if (Array.isArray(ast)) {
      if (ast.length !== 1) {
        return {
          valid: false,
          code: 'QUERY_MULTIPLE_STATEMENTS',
          message: 'Exactly one SQL statement is required.',
        };
      }
      [ast] = ast;
    }
    if (!isRecord(ast) || String(ast.type).toLowerCase() !== 'select') {
      return {
        valid: false,
        code: 'QUERY_NOT_READ_ONLY',
        message: 'Only SELECT queries are allowed.',
      };
    }

    let unsafe = false;
    const postgresParameters = new Set<number>();
    let mysqlParameters = 0;
    walk(ast, (node) => {
      const type = typeof node.type === 'string' ? node.type.toLowerCase() : '';
      if (
        [
          'insert',
          'update',
          'delete',
          'replace',
          'merge',
          'create',
          'alter',
          'drop',
          'truncate',
          'rename',
        ].includes(type)
      ) {
        unsafe = true;
      }
      const hasInto =
        type === 'select' &&
        isRecord(node.into) &&
        node.into.position !== null &&
        node.into.position !== undefined;
      if (hasInto || node.locking_read || node.for_update || node.for_share) unsafe = true;
      if (type === 'var' && node.prefix === '$' && typeof node.name === 'number')
        postgresParameters.add(node.name);
      if (type === 'origin' && node.value === '?') mysqlParameters += 1;
    });
    if (unsafe) {
      return {
        valid: false,
        code: 'QUERY_NOT_READ_ONLY',
        message: 'The SQL contains a write, lock, or export construct.',
      };
    }

    let objects: string[];
    try {
      objects = referencedObjects(parser, request.query, database, ast);
    } catch {
      return {
        valid: false,
        code: 'QUERY_SHAPE_UNSUPPORTED',
        message: 'Referenced objects could not be validated.',
      };
    }
    const namespaces = new Set(source.policy.allowedNamespaces.map(normalizedObject));
    const allowObjects = new Set(source.policy.allowedObjects.map(normalizedObject));
    const denied = objects.some((object) => {
      const namespace = object.includes('.')
        ? object.split('.')[0]
        : source.connection.database.toLocaleLowerCase('en-US');
      return (
        (namespaces.size > 0 && !namespaces.has(namespace)) ||
        (allowObjects.size > 0 && !allowObjects.has(object))
      );
    });
    if (denied) {
      return {
        valid: false,
        code: 'QUERY_OBJECT_DENIED',
        message: 'The query references an object outside the source allowlist.',
      };
    }

    const expected = request.parameters?.length ?? 0;
    let placeholderCount = 0;
    if (dialect === 'postgresql') {
      placeholderCount = postgresParameters.size ? Math.max(...postgresParameters) : 0;
      for (let index = 1; index <= placeholderCount; index += 1) {
        if (!postgresParameters.has(index)) {
          return {
            valid: false,
            code: 'QUERY_PARAMETER_MISMATCH',
            message: 'PostgreSQL placeholders must be contiguous.',
          };
        }
      }
    } else {
      placeholderCount = mysqlParameters;
    }
    if (placeholderCount !== expected) {
      return {
        valid: false,
        code: 'QUERY_PARAMETER_MISMATCH',
        message: 'SQL placeholder count does not match parameters.',
      };
    }

    try {
      const safeSql = parser.sqlify(ast as never, { database }).replace(/;\s*$/, '');
      if (!safeSql || safeSql.length > 60_000) throw new Error('unsupported serialization');
      return {
        valid: true,
        dialect,
        safeSql,
        referencedObjects: objects,
        placeholderCount,
      };
    } catch {
      return {
        valid: false,
        code: 'QUERY_SHAPE_UNSUPPORTED',
        message: 'The SQL shape cannot be serialized safely.',
      };
    }
  }
}
