import { describe, it, expect, vi } from 'vitest';
import {
  buildSubAgentInvoker,
  type ToolRegistryExecutor,
  type SubAgentInvokerContext,
} from '@/core/skills/buildSubAgentInvoker';

type ExecuteFn = ToolRegistryExecutor['execute'];
type ExecuteRequest = Parameters<ExecuteFn>[0];
type ExecuteResponse = Awaited<ReturnType<ExecuteFn>>;

const ctx = (overrides: Partial<SubAgentInvokerContext> = {}): SubAgentInvokerContext => ({
  sessionId: 'sess-abc',
  turnId: 'turn-xyz',
  callId: 'call-123',
  ...overrides,
});

const okExec = (data: unknown): ExecuteFn => async () => ({ success: true, data });
const failExec = (error: { code?: string; message?: string }): ExecuteFn => async () => ({ success: false, error });

const successPayload = JSON.stringify({
  success: true,
  response: 'sub-agent done',
  runId: 'run-007',
  turnCount: 3,
});

function captureExec(impl: ExecuteFn = okExec(successPayload)) {
  return vi.fn<(req: ExecuteRequest) => Promise<ExecuteResponse>>(impl);
}

describe('buildSubAgentInvoker — context plumbing (B2 regression test)', () => {
  it('passes ctx.sessionId / turnId / callId straight to registry.execute', async () => {
    const exec = captureExec();
    const invoker = buildSubAgentInvoker({ execute: exec }, ctx());

    await invoker({ type: 'general-purpose', prompt: 'hi', description: 'test' });

    expect(exec).toHaveBeenCalledTimes(1);
    const call = exec.mock.calls[0][0];
    expect(call.sessionId).toBe('sess-abc');
    expect(call.turnId).toBe('turn-xyz');
    expect(call.callId).toBe('call-123');
    expect(call.toolName).toBe('sub_agent');
  });

  it('callId is optional (undefined ok)', async () => {
    const exec = captureExec();
    const invoker = buildSubAgentInvoker({ execute: exec }, ctx({ callId: undefined }));

    await invoker({ type: 'general-purpose', prompt: 'hi', description: 'test' });

    expect(exec.mock.calls[0][0].callId).toBeUndefined();
  });

  it('forces background: false on the sub_agent params', async () => {
    const exec = captureExec();
    const invoker = buildSubAgentInvoker({ execute: exec }, ctx());

    await invoker({ type: 'general-purpose', prompt: 'hi', description: 'test' });

    expect(exec.mock.calls[0][0].parameters).toMatchObject({
      type: 'general-purpose',
      prompt: 'hi',
      description: 'test',
      background: false,
    });
  });

  it('forwards type/prompt/description from invoker params unchanged', async () => {
    const exec = captureExec();
    const invoker = buildSubAgentInvoker({ execute: exec }, ctx());

    await invoker({ type: 'reviewer', prompt: 'review the diff', description: 'PR review' });

    const params = exec.mock.calls[0][0].parameters;
    expect(params.type).toBe('reviewer');
    expect(params.prompt).toBe('review the diff');
    expect(params.description).toBe('PR review');
  });
});

describe('buildSubAgentInvoker — happy path', () => {
  it('parses string JSON output into a SubAgentResult', async () => {
    const invoker = buildSubAgentInvoker({ execute: okExec(successPayload) }, ctx());
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(true);
    expect(result.runId).toBe('run-007');
    expect(result.response).toBe('sub-agent done');
  });

  it('passes through already-parsed object output', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: okExec({ success: true, runId: 'run-x', response: 'inline' }) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(true);
    expect(result.response).toBe('inline');
  });
});

describe('buildSubAgentInvoker — error handling (H3 regression test)', () => {
  it('execute() failure surfaces error.message when present', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: failExec({ code: 'TOOL_NOT_FOUND', message: 'sub_agent is not registered' }) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('sub_agent is not registered');
  });

  it('execute() failure falls back to error.code when message missing (S1)', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: failExec({ code: 'TOOL_NOT_FOUND' }) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('TOOL_NOT_FOUND');
  });

  it('execute() failure with no error info → "unknown error" sentinel', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: async () => ({ success: false }) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown error/);
  });

  it('non-JSON string output → structured "non-JSON" error', async () => {
    const invoker = buildSubAgentInvoker({ execute: okExec('not json{') }, ctx());
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.runId).toBe('');
    expect(result.error).toMatch(/non-JSON/);
  });

  it('valid JSON but missing success field → structured "malformed" error (H3)', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: okExec(JSON.stringify({ runId: 'run-1', response: 'x' })) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/malformed/);
  });

  it('valid JSON but missing runId field → structured "malformed" error (H3)', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: okExec(JSON.stringify({ success: true, response: 'x' })) },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/malformed/);
  });

  it('non-object JSON (e.g., null) → structured "malformed" error (H3)', async () => {
    const invoker = buildSubAgentInvoker({ execute: okExec('null') }, ctx());
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/malformed/);
  });

  it('execute() throws → structured invocation-failed error', async () => {
    const invoker = buildSubAgentInvoker(
      { execute: async () => { throw new Error('registry boom'); } },
      ctx(),
    );
    const result = await invoker({ type: 't', prompt: 'p', description: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/registry boom/);
  });
});
