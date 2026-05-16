/**
 * Marker-typed sanitizers — the ONLY legal way a string enters telemetry.
 *
 * Every helper returns {@link TelemetryMeta_VERIFIED_NOT_CONTENT} (= `never`),
 * so the compiler forces all string-valued telemetry through one of these.
 * Ported from claudy `services/analytics/metadata.ts` discipline.
 *
 * No imports from app code (keeps the telemetry core acyclic).
 */

import type { TelemetryMeta_VERIFIED_NOT_CONTENT } from './analytics';

/**
 * Sanitize a tool name. Built-in tool names are fixed identifiers (safe).
 * MCP tool names follow `mcp__<server>__<tool>` and can reveal user-specific
 * server configuration (PII-medium) → collapsed to `'mcp_tool'`.
 */
export function sanitizeToolName(
  toolName: string,
): TelemetryMeta_VERIFIED_NOT_CONTENT {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as unknown as TelemetryMeta_VERIFIED_NOT_CONTENT;
  }
  return toolName as unknown as TelemetryMeta_VERIFIED_NOT_CONTENT;
}

/**
 * Pass a value through only if it is a member of a known bounded set;
 * anything else collapses to `'other'`. Use for enum-like fields whose
 * domain is closed and non-sensitive (status, mode, reason codes).
 */
export function boundedEnum<T extends string>(
  value: T | string | undefined,
  allowed: readonly T[],
): TelemetryMeta_VERIFIED_NOT_CONTENT | undefined {
  if (value === undefined) return undefined;
  return (
    allowed.includes(value as T) ? value : 'other'
  ) as unknown as TelemetryMeta_VERIFIED_NOT_CONTENT;
}

/**
 * Coerce a value to a finite number, or `undefined`. Never emits a string.
 */
export function numericOnly(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The constructor name of an error — never its message (which may carry
 * URLs/paths/secrets). Safe to log as a coarse failure dimension.
 */
export function errorClass(
  err: unknown,
): TelemetryMeta_VERIFIED_NOT_CONTENT | undefined {
  if (err == null) return undefined;
  const name =
    err instanceof Error
      ? err.constructor?.name || 'Error'
      : typeof err === 'object'
        ? ((err as { constructor?: { name?: string } }).constructor?.name ??
          'Object')
        : typeof err;
  return name as unknown as TelemetryMeta_VERIFIED_NOT_CONTENT;
}
