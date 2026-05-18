/**
 * Track 14 (Plan Review): the SubmitPlanForReview handler's decision
 * branches — approve, approve-with-edits (valid + invalid), plain deny,
 * and reject-with-feedback. Guards the discriminated edited-plan parse
 * and the freeze-lift / artifact-status wiring.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { registerPlanReviewTools } from '@/tools/planReview/PlanReviewTools';
import { SUBMIT_PLAN_TOOL_NAME } from '@/tools/planReview/types';
import type { ApprovalManager, ApprovalResponse } from '@/core/ApprovalManager';

const VALID_PARAMS = {
  summary: 'Buy the item',
  steps: [
    { description: 'open cart', mutating: false },
    { description: 'click buy', mutating: true },
  ],
};

async function runSubmit(
  resp: Partial<ApprovalResponse>,
  params: Record<string, unknown> = VALID_PARAMS,
) {
  const registry = new ToolRegistry();
  const requestApproval = vi.fn().mockResolvedValue({
    id: 'x',
    decision: 'approve',
    timestamp: Date.now(),
    ...resp,
  } as ApprovalResponse);
  const approvalManager = { requestApproval } as unknown as ApprovalManager;
  const recordPlanArtifact = vi.fn();

  await registerPlanReviewTools({
    registry,
    approvalManager,
    platformId: 'extension',
    recordPlanArtifact,
  });
  registry.beginPlanReview();

  const r = await registry.execute({
    toolName: SUBMIT_PLAN_TOOL_NAME,
    parameters: params,
    sessionId: 's',
    turnId: 't',
  });
  return { r, registry, recordPlanArtifact };
}

describe('SubmitPlanForReview handler — approve / edit / reject', () => {
  it('approve → echoes Approved Plan and lifts the freeze', async () => {
    const { r, registry, recordPlanArtifact } = await runSubmit({ decision: 'approve' });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain('Approved Plan');
    expect(String(r.data)).not.toContain('edited by user');
    expect(registry.isPlanReviewActive()).toBe(false);
    expect(recordPlanArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('approve-with-edits (valid JSON in reason) → edited echo + editedBy user', async () => {
    const edited = JSON.stringify({
      summary: 'Edited approach',
      steps: [{ description: 'do x', mutating: true }],
    });
    const { r, registry, recordPlanArtifact } = await runSubmit({
      decision: 'reject',
      reason: edited,
    });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain('Approved Plan (edited by user)');
    expect(registry.isPlanReviewActive()).toBe(false);
    expect(recordPlanArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'edited', editedBy: 'user' }),
    );
  });

  it('approve-with-edits but the edited plan is invalid → distinct feedback, no execution', async () => {
    const badEdit = JSON.stringify({ summary: '', steps: [] });
    const { r, registry } = await runSubmit({ decision: 'reject', reason: badEdit });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain('edited plan was');
    expect(String(r.data)).toContain('not valid');
    expect(String(r.data)).not.toContain('Approved Plan');
    expect(registry.isPlanReviewActive()).toBe(false);
  });

  it('plain deny → rejection echo without surfacing the boilerplate reason', async () => {
    const { r } = await runSubmit({ decision: 'reject', reason: 'Denied by user' });
    expect(String(r.data)).toContain('rejected your plan');
    expect(String(r.data)).not.toContain('User feedback');
  });

  it('reject with free-text feedback → surfaces it to the model', async () => {
    const { r } = await runSubmit({ decision: 'reject', reason: 'use the API instead' });
    expect(String(r.data)).toContain('rejected your plan');
    expect(String(r.data)).toContain('User feedback: use the API instead');
  });
});
