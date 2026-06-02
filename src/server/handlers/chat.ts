/**
 * Chat Method Handlers
 *
 * Handles chat.send, chat.abort, chat.history, chat.inject.
 *
 * @module server/handlers/chat
 */

import { registerMethodHandler, type MethodContext } from '@applepi/ws-server';
import { invalidRequest } from '@applepi/ws-server';
import type { Op, InputItem, SandboxPolicy } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';

// ─────────────────────────────────────────────────────────────────────────
// Handler dependencies (injected at registration time)
// ─────────────────────────────────────────────────────────────────────────

export interface ChatHandlerDeps {
  /**
   * Submit an Op to the agent. Returns the runtime submission id (runId) so
   * callers (e.g. external app-server automation) get a stable identifier.
   */
  submitOp: (op: Op, context: SubmissionContext) => Promise<string | void>;
  getHistory: (sessionKey: string) => Promise<unknown[]>;
}

/**
 * Resolve the originating channel for a submission. App-server / multi-channel
 * callers populate `ctx.channelId`/`ctx.channelType`; the headless server omits
 * them and falls back to the historical `server-main`/`server` identity.
 */
function callerChannel(ctx: MethodContext): { channelId: string; channelType: SubmissionContext['channelType'] } {
  return {
    channelId: ctx.channelId ?? 'server-main',
    channelType: (ctx.channelType as SubmissionContext['channelType']) ?? 'server',
  };
}

let _deps: ChatHandlerDeps | null = null;

export function registerChatHandlers(deps: ChatHandlerDeps): void {
  _deps = deps;

  registerMethodHandler('chat.send', handleChatSend);
  registerMethodHandler('chat.abort', handleChatAbort);
  registerMethodHandler('chat.history', handleChatHistory);
  registerMethodHandler('chat.inject', handleChatInject);
}

// ─────────────────────────────────────────────────────────────────────────
// chat.send
// ─────────────────────────────────────────────────────────────────────────

async function handleChatSend(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Chat handlers not initialized');

  const message = params?.message as string | undefined;
  const items = params?.items as InputItem[] | undefined;
  const model = params?.model as string | undefined;

  if (!message && (!items || items.length === 0)) {
    throw invalidRequest('Either "message" or "items" is required');
  }

  // Build InputItems from message text if not provided
  const inputItems: InputItem[] = items ?? [{ type: 'text', text: message! }];

  const op: Op = {
    type: 'UserTurn',
    items: inputItems,
    tabId: (params?.tabId as number) ?? 0,
    approval_policy: ((params?.approval_policy as string) ?? 'untrusted') as 'untrusted' | 'on-failure' | 'on-request' | 'never',
    sandbox_policy: (params?.sandbox_policy ?? { mode: 'danger-full-access' }) as SandboxPolicy,
    model: model ?? 'default',
    summary: { enabled: true },
  };

  const submissionContext: SubmissionContext = {
    ...callerChannel(ctx),
    userId: ctx.userId,
    sessionId: ctx.sessionKey,
  };

  // Submit asynchronously — response streaming is handled by events.
  // The submission id is surfaced as runId for stable automation.
  const runId = await _deps.submitOp(op, submissionContext);

  return { status: 'started', sessionKey: ctx.sessionKey, runId: runId ?? undefined, accepted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// chat.abort
// ─────────────────────────────────────────────────────────────────────────

async function handleChatAbort(
  _params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Chat handlers not initialized');

  const op: Op = { type: 'Interrupt' };

  const submissionContext: SubmissionContext = {
    ...callerChannel(ctx),
    userId: ctx.userId,
    sessionId: ctx.sessionKey,
  };

  await _deps.submitOp(op, submissionContext);
  return { status: 'aborted' };
}

// ─────────────────────────────────────────────────────────────────────────
// chat.history
// ─────────────────────────────────────────────────────────────────────────

async function handleChatHistory(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Chat handlers not initialized');

  const sessionKey = (params?.sessionKey as string) ?? ctx.sessionKey;
  if (!sessionKey) {
    throw invalidRequest('sessionKey is required');
  }

  const history = await _deps.getHistory(sessionKey);
  return { sessionKey, messages: history };
}

// ─────────────────────────────────────────────────────────────────────────
// chat.inject
// ─────────────────────────────────────────────────────────────────────────

async function handleChatInject(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Chat handlers not initialized');

  const text = params?.text as string | undefined;
  if (!text) {
    throw invalidRequest('"text" is required for chat.inject');
  }

  const op: Op = {
    type: 'AddToHistory',
    text,
  };

  const submissionContext: SubmissionContext = {
    ...callerChannel(ctx),
    userId: ctx.userId,
    sessionId: ctx.sessionKey,
  };

  await _deps.submitOp(op, submissionContext);
  return { status: 'injected' };
}
