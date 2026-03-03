/**
 * Execution Approval Method Handler
 *
 * Handles exec.approval.resolve — resolves pending approval requests.
 *
 * @module server/handlers/exec
 */

import { registerMethodHandler, type MethodContext } from '@applepi/ws-server';
import { invalidRequest, notFound } from '@applepi/ws-server';

export interface ExecHandlerDeps {
  resolveApproval: (id: string, decision: 'approve' | 'reject', reason?: string) => Promise<boolean>;
}

let _deps: ExecHandlerDeps | null = null;

export function registerExecHandlers(deps: ExecHandlerDeps): void {
  _deps = deps;
  registerMethodHandler('exec.approval.resolve', handleExecApprovalResolve);
}

async function handleExecApprovalResolve(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Exec handlers not initialized');

  const id = params?.id as string;
  const decision = params?.decision as 'approve' | 'reject';
  const reason = params?.reason as string | undefined;

  if (!id) throw invalidRequest('"id" is required');
  if (!decision || (decision !== 'approve' && decision !== 'reject')) {
    throw invalidRequest('"decision" must be "approve" or "reject"');
  }

  const resolved = await _deps.resolveApproval(id, decision, reason);
  if (!resolved) {
    throw notFound(`Approval request not found or already resolved: ${id}`);
  }

  return { status: 'resolved', id, decision };
}
