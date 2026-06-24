/**
 * Model Method Handlers
 *
 * Handles models.testConnection for web/server RPC clients by delegating to the
 * shared runtime-side model service implementation.
 *
 * @module server/handlers/models
 */

import { registerMethodHandler, unauthorized, type MethodContext } from '@workx/ws-server';
import { testModelConnection } from '@/core/services/models-services';
import { getConnectionAuth } from '../auth/authorize';
import { getServerConfig } from '../config/server-config';

export function registerModelHandlers(): void {
  registerMethodHandler('models.testConnection', handleModelsTestConnection);
}

function requireSecureTransport(ctx: MethodContext): void {
  const config = getServerConfig();
  const conn = getConnectionAuth(ctx.connectionId);
  if (config.server.tls.enabled || conn?.isLoopback) return;
  throw unauthorized('Connection tests require TLS or loopback connection');
}

async function handleModelsTestConnection(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext,
): Promise<unknown> {
  requireSecureTransport(ctx);
  return testModelConnection(params ?? {});
}
