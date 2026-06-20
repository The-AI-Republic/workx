/**
 * Track 05b: tests that `ToolRegistry.setPreExecuteCheck` actually gates
 * `execute()` calls before they reach the approval system. This is the
 * mechanism the session-summary extractor uses to lock `file_edit` to a
 * single allowed path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { PreExecuteCheck } from '@/tools/ToolRegistry';
import type { ToolDefinition, ToolHandler } from '@/tools/BaseTool';

function makeTool(name: string): ToolDefinition {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name,
      strict: true,
      // `additionalProperties: true` so tests can pass arbitrary params
      // without the registry's schema validator rejecting them first.
      parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: true },
    },
  };
}

function makeHandler(): ToolHandler {
  return vi.fn().mockResolvedValue({ ok: true, output: 'handler ran' });
}

describe('ToolRegistry.setPreExecuteCheck', () => {
  let registry: ToolRegistry;
  let handler: ReturnType<typeof makeHandler>;

  beforeEach(async () => {
    registry = new ToolRegistry();
    handler = makeHandler();
    await registry.register(makeTool('file_edit'), handler);
  });

  it('with no preExecuteCheck installed, execute() runs the handler normally', async () => {
    const result = await registry.execute({
      toolName: 'file_edit',
      parameters: { path: '/anywhere' },
      sessionId: 's',
      turnId: 't',
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preExecuteCheck "deny" short-circuits before the handler runs', async () => {
    const gate: PreExecuteCheck = () => ({
      behavior: 'deny',
      decisionReason: 'not allowed',
    });
    registry.setPreExecuteCheck(gate);

    const result = await registry.execute({
      toolName: 'file_edit',
      parameters: { path: '/anywhere' },
      sessionId: 's',
      turnId: 't',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRE_EXECUTE_DENIED');
    expect(result.error?.details).toMatchObject({ reason: 'not allowed' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('preExecuteCheck "allow" lets the handler run', async () => {
    const gate: PreExecuteCheck = vi.fn(
      () => ({ behavior: 'allow' as const }),
    );
    registry.setPreExecuteCheck(gate);

    const result = await registry.execute({
      toolName: 'file_edit',
      parameters: { path: '/allowed' },
      sessionId: 's',
      turnId: 't',
    });

    expect(result.success).toBe(true);
    expect(gate).toHaveBeenCalledWith('file_edit', { path: '/allowed' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('clearing the check via setPreExecuteCheck(undefined) restores normal flow', async () => {
    registry.setPreExecuteCheck(() => ({ behavior: 'deny', decisionReason: 'no' }));
    registry.setPreExecuteCheck(undefined);

    const result = await registry.execute({
      toolName: 'file_edit',
      parameters: {},
      sessionId: 's',
      turnId: 't',
    });
    expect(result.success).toBe(true);
  });
});
