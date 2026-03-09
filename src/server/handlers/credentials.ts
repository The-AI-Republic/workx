/**
 * Credential Method Handlers
 *
 * Handles credentials.list, credentials.set, credentials.delete —
 * secure API key management for server mode.
 *
 * Security: credentials.set and credentials.delete require TLS or loopback
 * to prevent plaintext key transmission over the network.
 *
 * @module server/handlers/credentials
 */

import { registerMethodHandler, type MethodContext } from '@applepi/ws-server';
import { invalidRequest, unauthorized } from '@applepi/ws-server';
import { getConnectionAuth } from '../auth/authorize';
import { getServerConfig } from '../config/server-config';

// ─────────────────────────────────────────────────────────────────────────
// Dependency injection
// ─────────────────────────────────────────────────────────────────────────

export interface CredentialHandlerDeps {
  setProviderApiKey: (providerId: string, apiKey: string) => Promise<unknown>;
  deleteProviderApiKey: (providerId: string) => Promise<void>;
  listProviders: () => Promise<{ id: string; name: string; hasKey: boolean }[]>;
}

let _deps: CredentialHandlerDeps | null = null;

export function registerCredentialsHandlers(deps: CredentialHandlerDeps): void {
  _deps = deps;
  registerMethodHandler('credentials.list', handleCredentialsList);
  registerMethodHandler('credentials.set', handleCredentialsSet);
  registerMethodHandler('credentials.delete', handleCredentialsDelete);
}

// ─────────────────────────────────────────────────────────────────────────
// Security helper
// ─────────────────────────────────────────────────────────────────────────

function requireSecureTransport(ctx: MethodContext): void {
  const config = getServerConfig();
  const conn = getConnectionAuth(ctx.connectionId);
  if (config.server.tls.enabled || conn?.isLoopback) return;
  throw unauthorized('Credential writes require TLS or loopback connection');
}

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

// No requireSecureTransport — list returns metadata only (id, name, hasKey boolean),
// never actual secrets. Keep this read-only and safe for non-TLS connections.
async function handleCredentialsList(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Credential handlers not initialized');

  const providers = await _deps.listProviders();
  return { providers };
}

async function handleCredentialsSet(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Credential handlers not initialized');

  requireSecureTransport(ctx);

  const providerId = params?.providerId as string;
  const apiKey = params?.apiKey as string;

  if (!providerId) throw invalidRequest('"providerId" is required');
  if (!apiKey) throw invalidRequest('"apiKey" is required');

  console.log(`[credentials] Setting API key for provider "${providerId}" (connection: ${ctx.connectionId})`);
  try {
    await _deps.setProviderApiKey(providerId, apiKey);
  } catch (error) {
    console.error(`[credentials] Failed to set API key for provider "${providerId}":`, error);
    throw error;
  }

  console.log(`[credentials] API key set for provider "${providerId}"`);
  return { status: 'ok', providerId };
}

async function handleCredentialsDelete(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Credential handlers not initialized');

  requireSecureTransport(ctx);

  const providerId = params?.providerId as string;
  if (!providerId) throw invalidRequest('"providerId" is required');

  console.log(`[credentials] Deleting API key for provider "${providerId}" (connection: ${ctx.connectionId})`);
  try {
    await _deps.deleteProviderApiKey(providerId);
  } catch (error) {
    console.error(`[credentials] Failed to delete API key for provider "${providerId}":`, error);
    throw error;
  }

  console.log(`[credentials] API key deleted for provider "${providerId}"`);
  return { status: 'ok', providerId };
}
