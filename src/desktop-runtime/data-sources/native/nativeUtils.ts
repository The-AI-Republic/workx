import { createHash } from 'node:crypto';
import type {
  DataColumn,
  DataObjectDescription,
  DataObjectRef,
  DataSource,
  DataSourceCapabilities,
  DataSourceDescription,
  DataSourceSummary,
} from '@/core/data-sources';
import { DataSourceError } from '@/core/data-sources';

export interface SchemaCacheValue {
  expiresAt: number;
  description: DataSourceDescription;
}

export function sourceSummary(
  source: DataSource,
  capabilities: DataSourceCapabilities
): DataSourceSummary {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    category: source.category,
    connectorId: source.connectorId,
    transport: source.transport.type,
    businessTimezone: source.businessTimezone,
    isDefault: source.isDefault,
    capabilities: {
      queryLanguages: capabilities.queryLanguages,
      schemaDiscovery: capabilities.schemaDiscovery,
      resultShapes: capabilities.resultShapes,
    },
  };
}

export function schemaFingerprint(objects: Array<DataObjectRef | DataObjectDescription>): string {
  const identity = objects
    .map((object) => {
      const fields =
        'fields' in object
          ? object.fields.map((field) => `${field.name}:${field.databaseType}`).sort()
          : [];
      return `${object.qualifiedName}|${object.kind}|${fields.join(',')}`;
    })
    .sort()
    .join('\n');
  return createHash('sha256').update(identity).digest('hex');
}

export function queryHash(connectorId: string, safeSql: string): string {
  return createHash('sha256').update(`${connectorId}\n${safeSql}`).digest('hex');
}

export function encodeCursor(offset: number, search = ''): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      offset,
      search: search.trim().toLocaleLowerCase('en-US'),
    })
  ).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, search = ''): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: number;
      offset?: number;
      search?: string;
    };
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      parsed.search !== search.trim().toLocaleLowerCase('en-US')
    ) {
      throw new Error('invalid cursor');
    }
    return parsed.offset!;
  } catch {
    throw new DataSourceError('SCHEMA_NOT_FOUND', 'Schema cursor is invalid or stale.');
  }
}

export function normalizeColumnType(
  databaseType: string,
  dialect?: 'postgresql' | 'mysql'
): DataColumn['normalizedType'] {
  const type = databaseType.toLocaleLowerCase('en-US');
  if (dialect === 'postgresql') {
    if (type === '16') return 'boolean';
    if (['20', '21', '23', '26', '700', '701', '790', '1700'].includes(type)) return 'number';
    if (['1082', '1083', '1114', '1184', '1266'].includes(type)) return 'date';
    if (['114', '3802'].includes(type)) return 'json';
    if (type === '17') return 'binary-omitted';
  }
  if (dialect === 'mysql') {
    const code = Number(type);
    if (code === 6) return 'null';
    if (code === 244) return 'boolean';
    if ([0, 1, 2, 3, 4, 5, 8, 9, 13, 16, 246].includes(code)) return 'number';
    if ([7, 10, 11, 12, 14, 17, 18, 19].includes(code)) return 'date';
    if (code === 245) return 'json';
    if ([249, 250, 251, 252].includes(code)) return 'binary-omitted';
  }
  if (/bool/.test(type)) return 'boolean';
  if (/(^|\b)(int|float|double|real|decimal|numeric|money)/.test(type)) return 'number';
  if (/(date|time)/.test(type)) return 'date';
  if (/json/.test(type)) return 'json';
  if (/(bytea|blob|binary)/.test(type)) return 'binary-omitted';
  return 'string';
}

export function sourceSchemaCacheKey(
  source: DataSource,
  scope: string,
  objects: string[] | undefined,
  search: string
): string {
  const policy = createHash('sha256')
    .update(JSON.stringify([source.policy.allowedNamespaces, source.policy.allowedObjects]))
    .digest('hex');
  return `${source.id}:${source.connectionRevision}:${policy}:${scope}:${(objects ?? []).join(',')}:${search}`;
}

export function clampTimeout(source: DataSource): number {
  return Math.max(1_000, Math.min(60_000, Math.trunc(source.policy.timeoutMs)));
}

function normalizedIdentifier(value: string): string {
  return value
    .normalize('NFKC')
    .split('.')
    .map((part) =>
      part
        .trim()
        .replace(/^[`"]|[`"]$/g, '')
        .toLocaleLowerCase('en-US')
    )
    .join('.');
}

export function splitQualifiedObject(value: string): { namespace: string; name: string } | null {
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { namespace: value.slice(0, separator), name: value.slice(separator + 1) };
}

export function isDataObjectAllowed(source: DataSource, namespace: string, name: string): boolean {
  const normalizedNamespace = normalizedIdentifier(namespace);
  const normalizedObject = normalizedIdentifier(`${namespace}.${name}`);
  const namespaces = new Set(source.policy.allowedNamespaces.map(normalizedIdentifier));
  const objects = new Set(source.policy.allowedObjects.map(normalizedIdentifier));
  return (
    (!namespaces.size || namespaces.has(normalizedNamespace)) &&
    (!objects.size || objects.has(normalizedObject))
  );
}
