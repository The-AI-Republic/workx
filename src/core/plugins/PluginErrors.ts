/**
 * PluginErrors — human-readable rendering for the `PluginError` union.
 *
 * The union itself lives in `types.ts` (to avoid circular imports with
 * `LoadedPlugin.loadErrors`). This module is just the message formatter
 * used by `/plugin info <id>` and log output.
 *
 * Reference: design.md § Type Model > PluginError.
 */

import type { PluginError } from './types';

/**
 * Render a `PluginError` as a short human-readable line. Used by
 * `/plugin info` output and structured logs.
 */
export function getPluginErrorMessage(err: PluginError): string {
  switch (err.type) {
    case 'generic-error':
      return err.message;
    case 'plugin-not-found':
      return `Plugin not found: ${err.pluginId}`;
    case 'path-not-found':
      return `Path not found for ${err.pluginId}: ${err.path}`;
    case 'manifest-parse-error':
      return `Manifest parse error at ${err.path}: ${err.cause}`;
    case 'manifest-validation-error':
      return `Manifest validation failed at ${err.path}: ${err.issues.join('; ')}`;
    case 'component-load-failed':
      return `Failed to load ${err.slot} for ${err.pluginId}: ${err.cause}`;
    case 'marketplace-blocked-by-policy':
      return err.blockedByBlocklist
        ? `Plugin ${err.pluginId} blocked by org blocklist`
        : `Plugin ${err.pluginId} blocked by org policy`;
    case 'mcp-server-suppressed-duplicate':
      return `MCP server "${err.key}" from ${err.pluginId} suppressed (key already in use)`;
  }
}

/**
 * Coerce an unknown thrown value into a `PluginError`. Used by the
 * registry's catch blocks so error surfaces stay typed.
 */
export function toPluginError(e: unknown, pluginId?: string): PluginError {
  if (e && typeof e === 'object' && 'type' in e && typeof (e as { type: unknown }).type === 'string') {
    // Already a structured PluginError (or close enough — let it through)
    return e as PluginError;
  }
  const message = e instanceof Error ? e.message : String(e);
  return { type: 'generic-error', message, pluginId };
}
