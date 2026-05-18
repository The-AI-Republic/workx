/**
 * Track 14 (Plan Review): the categorical freeze in ToolRegistry.execute().
 * While plan review is active, every non-read-only tool call is hard-denied
 * before the approval gate; read-only calls pass; exiting lifts the freeze.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition, ToolHandler } from '@/tools/BaseTool';

function makeTool(name: string): ToolDefinition {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name,
      strict: true,
      parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: true },
    },
  };
}

const readOnly = { isConcurrencySafe: () => true, isReadOnly: () => true, isDestructive: () => false };
const mutating = { isConcurrencySafe: () => false, isReadOnly: () => false, isDestructive: () => false };

describe('ToolRegistry plan review freeze', () => {
  let registry: ToolRegistry;
  let readerHandler: ReturnType<typeof vi.fn>;
  let mutatorHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    registry = new ToolRegistry();
    readerHandler = vi.fn().mockResolvedValue('read ok');
    mutatorHandler = vi.fn().mockResolvedValue('mutated');
    await registry.register(makeTool('snapshot'), readerHandler as ToolHandler, {
      runtime: { concurrency: readOnly },
    });
    await registry.register(makeTool('click'), mutatorHandler as ToolHandler, {
      runtime: { concurrency: mutating },
    });
  });

  const exec = (toolName: string) =>
    registry.execute({ toolName, parameters: {}, sessionId: 's', turnId: 't' });

  it('defaults to inactive — mutating tools run normally', async () => {
    expect(registry.isPlanReviewActive()).toBe(false);
    const r = await exec('click');
    expect(r.success).toBe(true);
    expect(mutatorHandler).toHaveBeenCalledTimes(1);
  });

  it('freezes non-read-only tools while active (deny before handler)', async () => {
    registry.beginPlanReview();
    expect(registry.isPlanReviewActive()).toBe(true);

    const r = await exec('click');
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('APPROVAL_DENIED');
    expect(r.error?.details).toMatchObject({ reason: 'plan-review-freeze' });
    expect(mutatorHandler).not.toHaveBeenCalled();
  });

  it('lets read-only tools through while active', async () => {
    registry.beginPlanReview();
    const r = await exec('snapshot');
    expect(r.success).toBe(true);
    expect(readerHandler).toHaveBeenCalledTimes(1);
  });

  it('endPlanReview lifts the freeze; begin/end are idempotent', async () => {
    registry.beginPlanReview();
    registry.beginPlanReview(); // idempotent
    expect((await exec('click')).success).toBe(false);

    registry.endPlanReview();
    registry.endPlanReview(); // idempotent
    expect(registry.isPlanReviewActive()).toBe(false);

    const r = await exec('click');
    expect(r.success).toBe(true);
    expect(mutatorHandler).toHaveBeenCalledTimes(1);
  });
});
