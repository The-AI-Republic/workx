/**
 * App-Server HTTP Health Endpoints
 *
 * Pure helpers for /readyz, /healthz, and the /health compatibility alias.
 * No secrets are ever included.
 *
 * @module app-server/transport/httpHealth
 */

import type { AppServerStatusSnapshot } from '../status/AppServerStatus';

export interface HealthContext {
  status: AppServerStatusSnapshot;
  profile: string;
  startedAtMs: number;
  now: number;
}

export interface HttpHealthResponse {
  statusCode: number;
  body: string;
  contentType: string;
}

/** Build the JSON body for /healthz and /health. */
export function buildHealthBody(ctx: HealthContext): Record<string, unknown> {
  return {
    status: ctx.status.status,
    profile: ctx.profile,
    connections: ctx.status.connections,
    uptimeMs: Math.max(0, ctx.now - ctx.startedAtMs),
  };
}

/**
 * Handle a health-related GET request. Returns null if the path is not a
 * health endpoint (caller should 404).
 */
export function handleHealthRequest(
  method: string | undefined,
  url: string | undefined,
  ctx: HealthContext,
): HttpHealthResponse | null {
  if (method !== 'GET') return null;
  const path = (url ?? '').split('?')[0];

  if (path === '/readyz') {
    const ready = ctx.status.status === 'ready';
    return {
      statusCode: ready ? 200 : 503,
      contentType: 'text/plain',
      body: ready ? 'ok' : 'not ready',
    };
  }

  if (path === '/healthz' || path === '/health') {
    return {
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildHealthBody(ctx)),
    };
  }

  return null;
}
