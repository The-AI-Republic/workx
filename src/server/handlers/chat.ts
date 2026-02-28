/**
 * Chat Method Handlers
 *
 * Handles chat.send, chat.abort, chat.history, chat.inject.
 *
 * @module server/handlers/chat
 */

import { registerMethodHandler, type MethodContext } from '../protocol/methods';
import { invalidRequest } from '../protocol/errors';
import type { Op, InputItem } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';

// ─────────────────────────────────────────────────────────────────────────
// Handler dependencies (injected at registration time)
// ─────────────────────────────────────────────────────────────────────────

export interface ChatHandlerDeps {
  submitOp: (op: Op, context: SubmissionContext) => Promise<void>;
  getHistory: (sessionKey: string) => Promise<unknown[]>;
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
    sandbox_policy: (params?.sandbox_policy as { mode: string }) ?? { mode: 'danger-full-access' },
    model: model ?? 'default',
    summary: { enabled: true },
  };

  const submissionContext: SubmissionContext = {
    channelId: 'server-main',
    channelType: 'server',
    userId: ctx.userId,
    sessionId: ctx.sessionKey,
  };

  // Submit asynchronously — response streaming is handled by events
  await _deps.submitOp(op, submissionContext);

  return { status: 'started', sessionKey: ctx.sessionKey };
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
    channelId: 'server-main',
    channelType: 'server',
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
    channelId: 'server-main',
    channelType: 'server',
    userId: ctx.userId,
    sessionId: ctx.sessionKey,
  };

  await _deps.submitOp(op, submissionContext);
  return { status: 'injected' };
}
