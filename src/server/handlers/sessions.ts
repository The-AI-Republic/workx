/**
 * Session Method Handlers
 *
 * Handles sessions.list, sessions.get, sessions.patch,
 * sessions.reset, sessions.delete, sessions.compact.
 *
 * @module server/handlers/sessions
 */

import { registerMethodHandler, type MethodContext } from '@pi/ws-server';
import { invalidRequest, notFound } from '@pi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────

export interface SessionHandlerDeps {
  listSessions: (filters?: { source?: string; status?: string }) => Promise<unknown[]>;
  getSession: (key: string) => Promise<unknown | null>;
  patchSession: (key: string, patch: Record<string, unknown>) => Promise<void>;
  resetSession: (key: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  compactSession: (key: string) => Promise<unknown>;
}

let _deps: SessionHandlerDeps | null = null;

export function registerSessionHandlers(deps: SessionHandlerDeps): void {
  _deps = deps;

  registerMethodHandler('sessions.list', handleSessionsList);
  registerMethodHandler('sessions.get', handleSessionsGet);
  registerMethodHandler('sessions.patch', handleSessionsPatch);
  registerMethodHandler('sessions.reset', handleSessionsReset);
  registerMethodHandler('sessions.delete', handleSessionsDelete);
  registerMethodHandler('sessions.compact', handleSessionsCompact);
}

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleSessionsList(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const sessions = await _deps.listSessions({
    source: params?.source as string | undefined,
    status: params?.status as string | undefined,
  });

  return { sessions };
}

async function handleSessionsGet(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const key = params?.key as string;
  if (!key) throw invalidRequest('"key" is required');

  const session = await _deps.getSession(key);
  if (!session) throw notFound(`Session not found: ${key}`);

  return session;
}

async function handleSessionsPatch(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const key = params?.key as string;
  const patch = params?.patch as Record<string, unknown>;
  if (!key) throw invalidRequest('"key" is required');
  if (!patch) throw invalidRequest('"patch" is required');

  await _deps.patchSession(key, patch);
  return { status: 'patched', key };
}

async function handleSessionsReset(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const key = params?.key as string;
  if (!key) throw invalidRequest('"key" is required');

  await _deps.resetSession(key);
  return { status: 'reset', key };
}

async function handleSessionsDelete(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const key = params?.key as string;
  if (!key) throw invalidRequest('"key" is required');

  await _deps.deleteSession(key);
  return { status: 'deleted', key };
}

async function handleSessionsCompact(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Session handlers not initialized');

  const key = params?.key as string;
  if (!key) throw invalidRequest('"key" is required');

  const result = await _deps.compactSession(key);
  return { status: 'compacted', key, ...((result as Record<string, unknown>) ?? {}) };
}
