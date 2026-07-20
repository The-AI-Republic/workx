import { redactSecretsInText } from '@/core/diagnostics/redact';
import type { DataSourceErrorCode } from './types';

const URI_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const CONNECTION_DETAIL =
  /\b(?:host|hostname|server|user|username)\s*[=:]\s*[^\s,;]+|\b(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH)\s+[^\s,;]+|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gi;

export class DataSourceError extends Error {
  constructor(
    readonly code: DataSourceErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DataSourceError';
  }
}

export function sanitizeDataSourceMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? 'Unknown data-source error');
  return redactSecretsInText(raw)
    .replace(URI_USERINFO, '$1[redacted]@')
    .replace(PEM_BLOCK, '[redacted certificate]')
    .replace(CONNECTION_DETAIL, '[redacted connection]')
    .slice(0, 500);
}

export function asDataSourceError(
  error: unknown,
  fallback: DataSourceErrorCode = 'SOURCE_UNREACHABLE'
): DataSourceError {
  if (error instanceof DataSourceError) return error;
  const message = sanitizeDataSourceMessage(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('password') ||
    lower.includes('authentication') ||
    lower.includes('access denied')
  ) {
    return new DataSourceError('AUTH_FAILED', 'Database authentication failed.');
  }
  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl')) {
    return new DataSourceError('TLS_FAILED', 'Database TLS negotiation failed.');
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new DataSourceError('CONNECT_TIMEOUT', 'Database connection timed out.', true);
  }
  const fallbackMessage =
    fallback === 'SCHEMA_NOT_FOUND'
      ? 'Database schema discovery failed.'
      : fallback.startsWith('QUERY_')
        ? 'Database query failed.'
        : 'Database connection failed.';
  return new DataSourceError(fallback, fallbackMessage);
}

export function assertDataSource(
  condition: unknown,
  code: DataSourceErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new DataSourceError(code, message);
}
