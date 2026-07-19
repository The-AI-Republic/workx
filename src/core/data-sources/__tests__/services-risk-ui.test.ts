import { describe, expect, it, vi } from 'vitest';
import { DataSourceRuntimeHandle, captureOriginalDataTurnSnapshot } from '@/core/data-sources';
import type { DataQueryRequest, LearnDataContextRequest } from '@/core/data-sources';
import { createDataSourceServices } from '@/core/services/data-sources-services';
import { StdioRuntimeChannel } from '@/desktop-runtime/channels/StdioRuntimeChannel';
import { EventProcessor } from '@/webfront/components/event_display/EventProcessor';
import { DataContextRiskAssessor } from '@/tools/data-sources/DataContextRiskAssessor';
import { DataQueryRiskAssessor } from '@/tools/data-sources/DataQueryRiskAssessor';
import { DATA_ANALYSIS_PROMPT } from '@/tools/data-sources/prompt';
import { DATA_QUERY_TOOL } from '@/tools/data-sources/definitions';
import type { ApprovalContext } from '@/core/approval/types';
import type { Event } from '@/core/protocol/types';
import type { StdioFrameCarrier } from '@/desktop-runtime/protocol/stdioCarrier';
import { sourceFixture } from './fixtures';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition } from '@/tools/BaseTool';

const desktopContext = {
  channelId: 'desktop-runtime-main',
  channelType: 'tauri' as const,
};

describe('data-source management services', () => {
  it('returns direct DTOs and guards every path to adapter-owned desktop identity', async () => {
    const source = sourceFixture();
    const runtime = {
      getConnectorIds: () => ['postgres-native'],
      listManagementSources: vi.fn().mockResolvedValue([{ source, passwordConfigured: true }]),
      createSource: vi.fn().mockResolvedValue({ source, passwordConfigured: true }),
    };
    const handle = new DataSourceRuntimeHandle();
    handle.setReady(runtime as never, true);
    const services = createDataSourceServices({ handle });

    await expect(services['dataSources.status']({}, desktopContext)).resolves.toMatchObject({
      available: true,
      toolsEnabled: true,
    });
    const listed = await services['dataSources.list']({}, desktopContext);
    expect(listed).toEqual([{ source, passwordConfigured: true }]);
    expect(listed).not.toHaveProperty('success');

    const createInput = {
      source: { name: 'source' },
      password: 'seeded-secret',
      leastPrivilegeAcknowledged: true,
    };
    await services['dataSources.create'](createInput, desktopContext);
    expect(runtime.createSource).toHaveBeenCalledWith(createInput);

    for (const path of Object.keys(services)) {
      await expect(
        services[path as keyof typeof services]({}, {
          channelId: 'desktop-runtime-main',
          channelType: 'websocket',
        } as never)
      ).rejects.toMatchObject({ code: 'SERVICE_FORBIDDEN' });
    }
  });

  it('keeps status truthful and other services unavailable after non-fatal initialization failure', async () => {
    const handle = new DataSourceRuntimeHandle();
    handle.setUnavailable('DATA_SOURCE_STORE_CORRUPT');
    const services = createDataSourceServices({ handle });
    await expect(services['dataSources.status']({}, desktopContext)).resolves.toEqual({
      state: 'unavailable',
      available: false,
      toolsEnabled: false,
      connectorIds: [],
      errorCode: 'DATA_SOURCE_STORE_CORRUPT',
    });
    await expect(services['dataSources.list']({}, desktopContext)).rejects.toMatchObject({
      code: 'DATA_SOURCES_UNAVAILABLE',
    });
  });
});

describe('stdio channel identity', () => {
  it('overwrites spoofed frame channel identity with adapter-owned values', async () => {
    let onFrame: ((frame: unknown) => void) | undefined;
    const sent: unknown[] = [];
    const carrier = {
      onFrame: vi.fn((handler) => {
        onFrame = handler;
        return () => undefined;
      }),
      send: vi.fn((frame) => sent.push(frame)),
    } as unknown as StdioFrameCarrier;
    const channel = new StdioRuntimeChannel(carrier);
    const submission = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(submission);
    await channel.initialize();
    onFrame?.({
      type: 'request',
      id: 'request-1',
      op: { type: 'Interrupt' },
      context: {
        channelId: 'attacker',
        channelType: 'websocket',
        sessionId: 'session-1',
      },
    });
    await vi.waitFor(() => expect(submission).toHaveBeenCalled());
    expect(submission.mock.calls[0][1]).toEqual({
      channelId: 'desktop-runtime-main',
      channelType: 'tauri',
      sessionId: 'session-1',
    });
    expect(sent).toContainEqual({ type: 'response', id: 'request-1', ok: true });
  });
});

describe('data risk assessors', () => {
  const query: DataQueryRequest = {
    source_id: sourceFixture().id,
    query_language: 'sql',
    query: 'SELECT count(*) FROM orders WHERE st = $1',
    parameters: [{ type: 'number', value: 2 }],
    purpose: 'Paid orders',
  };
  const snapshot = {
    currentUserText: 'In this database st = 2 means paid.',
    origin: {
      channel: 'local' as const,
      channelId: 'desktop-runtime-main',
      channelType: 'tauri',
    },
    attended: true,
    durableLearningEligible: true,
  };

  function approvalContext(currentUserText = snapshot.currentUserText): ApprovalContext {
    const dataTurnSnapshot = {
      origin: snapshot.origin,
      attended: snapshot.attended,
      durableLearningEligible: snapshot.durableLearningEligible,
    };
    return {
      toolName: 'data_tool',
      parameters: {},
      dataTurnSnapshot,
      currentUserText,
    };
  }

  it('auto-approves only validated current read-only sources and asks when configured', () => {
    const source = sourceFixture();
    const runtime = {
      getSourceForAssessment: () => source,
      validateQueryForAssessment: () => ({ valid: true }),
    };
    const assessor = new DataQueryRiskAssessor(runtime as never);
    expect(assessor.assess('data_query', query as never, approvalContext())).toMatchObject({
      score: 15,
      action: 'auto_approve',
    });
    source.policy.queryApproval = 'ask_each_query';
    expect(assessor.assess('data_query', query as never, approvalContext())).toMatchObject({
      action: 'ask_user',
    });
  });

  it('denies invalid SQL, stale acknowledgements, and non-desktop origins', () => {
    const source = sourceFixture();
    const runtime = {
      getSourceForAssessment: () => source,
      validateQueryForAssessment: () => ({ valid: false, message: 'write denied' }),
    };
    const assessor = new DataQueryRiskAssessor(runtime as never);
    expect(assessor.assess('data_query', query as never, approvalContext()).action).toBe('deny');
    source.policy.leastPrivilegeAcknowledgement = undefined;
    runtime.validateQueryForAssessment = () => ({ valid: true, message: '' });
    expect(assessor.assess('data_query', query as never, approvalContext()).action).toBe('deny');
    expect(
      assessor.assess('data_query', query as never, {
        toolName: 'data_query',
        parameters: query as never,
        dataTurnSnapshot: {
          origin: { channel: 'local', channelId: 'spoof', channelType: 'tauri' },
          attended: true,
          durableLearningEligible: true,
        },
      }).action
    ).toBe('deny');
  });

  it('uses exact current-turn evidence and honors automatic/ask/off learning', () => {
    const source = sourceFixture();
    const runtime = { getSourceForAssessment: () => source };
    const assessor = new DataContextRiskAssessor(runtime as never);
    const learn: LearnDataContextRequest = {
      source_id: source.id,
      reason: 'User explained status',
      facts: [
        {
          kind: 'enum_value',
          assertion: 'st = 2 means paid',
          evidence_quote: 'st = 2 means paid',
        },
      ],
    };
    expect(assessor.assess('data_learn_context', learn as never, approvalContext())).toMatchObject({
      action: 'auto_approve',
    });
    source.policy.learningMode = 'ask';
    expect(assessor.assess('data_learn_context', learn as never, approvalContext())).toMatchObject({
      action: 'ask_user',
    });
    source.policy.learningMode = 'off';
    expect(assessor.assess('data_learn_context', learn as never, approvalContext()).action).toBe(
      'deny'
    );
    source.policy.learningMode = 'automatic';
    expect(
      assessor.assess('data_learn_context', learn as never, approvalContext('No evidence here'))
        .action
    ).toBe('deny');
  });
});

describe('narrow original-turn evidence seam', () => {
  it('captures direct text and clipboard before enrichment while denying unattended durable evidence', () => {
    const origin = {
      channel: 'local' as const,
      channelId: 'desktop-runtime-main',
      channelType: 'tauri',
    };
    const snapshot = captureOriginalDataTurnSnapshot(
      {
        type: 'UserInput',
        items: [
          { type: 'text', text: 'st = 2 means paid' },
          { type: 'clipboard', content: 'amt is stored in cents' },
          { type: 'context', path: '/hook-added-context' },
          { type: 'image', image_url: 'data:image/png;base64,secret' },
        ],
      },
      { origin }
    );
    expect(snapshot.currentUserText).toBe('st = 2 means paid\namt is stored in cents');
    expect(snapshot.durableLearningEligible).toBe(true);
    origin.channelId = 'mutated-after-capture';
    expect(snapshot.origin.channelId).toBe('desktop-runtime-main');

    const scheduler = captureOriginalDataTurnSnapshot(
      { type: 'UserInput', items: [{ type: 'text', text: 'synthetic fact' }] },
      { origin: { channel: 'scheduler' }, unattended: true }
    );
    expect(scheduler).toMatchObject({ attended: false, durableLearningEligible: false });
  });

  it('exposes original text only to the learning assessor while keeping the snapshot data-tool-only', async () => {
    const registry = new ToolRegistry();
    const check = vi.fn().mockResolvedValue('auto_approve');
    registry.setApprovalGate({ check } as never);
    const handlerContexts = new Map<string, Record<string, unknown> | undefined>();
    const definition = (name: string): ToolDefinition => ({
      type: 'function',
      function: {
        name,
        description: `${name} fixture`,
        strict: true,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    });
    for (const name of ['ordinary_tool', 'data_query', 'data_learn_context']) {
      await registry.register(definition(name), async (_parameters, context) => {
        handlerContexts.set(name, context.metadata);
        return { ok: true };
      });
    }
    const originalSnapshot = {
      currentUserText: 'st = 2 means paid',
      origin: {
        channel: 'local' as const,
        channelId: 'desktop-runtime-main',
        channelType: 'tauri',
      },
      attended: true,
      durableLearningEligible: true,
    };
    for (const name of ['ordinary_tool', 'data_query', 'data_learn_context']) {
      const response = await registry.execute({
        toolName: name,
        parameters: {},
        sessionId: 'session-1',
        turnId: 'turn-1',
        metadata: {
          dataTurnSnapshot: originalSnapshot,
          currentUserText: 'hook-forged text',
        },
      });
      expect(response.success).toBe(true);
    }
    const gateContexts = Object.fromEntries(
      check.mock.calls.map((call) => [call[0], call[3] as Record<string, unknown>])
    );
    expect(gateContexts.ordinary_tool.dataTurnSnapshot).toBeUndefined();
    expect(gateContexts.ordinary_tool.currentUserText).toBeUndefined();
    expect(gateContexts.data_query.dataTurnSnapshot).toEqual({
      origin: originalSnapshot.origin,
      attended: true,
      durableLearningEligible: true,
    });
    expect(
      (gateContexts.data_query.dataTurnSnapshot as Record<string, unknown>).currentUserText
    ).toBeUndefined();
    expect(gateContexts.data_query.currentUserText).toBeUndefined();
    expect(gateContexts.data_learn_context.currentUserText).toBe('st = 2 means paid');
    expect(handlerContexts.get('ordinary_tool')).toEqual({ tabId: undefined });
    expect(handlerContexts.get('data_query')).toEqual({
      tabId: undefined,
      dataTurnSnapshot: {
        origin: originalSnapshot.origin,
        attended: true,
        durableLearningEligible: true,
      },
    });
    expect(handlerContexts.get('data_learn_context')).toEqual({
      tabId: undefined,
      dataTurnSnapshot: {
        origin: originalSnapshot.origin,
        attended: true,
        durableLearningEligible: true,
      },
      currentUserText: originalSnapshot.currentUserText,
    });
  });
});

describe('data progress UI and orchestration prompt', () => {
  function event(id: string, callId: string, progress_data: Record<string, unknown>): Event {
    return {
      id,
      msg: {
        type: 'ToolExecutionProgress',
        data: {
          tool_name: progress_data.type === 'data_query' ? 'data_query' : 'data_learn_context',
          call_id: callId,
          progress_data,
          timestamp: Date.now(),
        },
      },
    } as Event;
  }

  it('correlates query start/completion into one secret-free expandable card', () => {
    const processor = new EventProcessor('session-1');
    const started = processor.processEvent(
      event('event-1', 'call-1', {
        type: 'data_query',
        status: 'started',
        sourceName: 'Production Sales',
        connectorId: 'postgres-native',
        transport: 'native',
        purpose: 'Monthly paid sales',
        sql: 'SELECT sum(amt) FROM orders WHERE st = $1',
        parameterTypes: ['number'],
        parameterCount: 1,
      })
    );
    const completed = processor.processEvent(
      event('event-2', 'call-1', {
        type: 'data_query',
        status: 'completed',
        sourceName: 'Production Sales',
        connectorId: 'postgres-native',
        transport: 'native',
        purpose: 'Monthly paid sales',
        parameterTypes: ['number'],
        parameterCount: 1,
        durationMs: 42,
        rowCount: 1,
        truncated: false,
      })
    );
    expect(started?.id).toBe('data-query:call-1');
    expect(completed?.id).toBe(started?.id);
    expect(completed).toMatchObject({ category: 'system', status: 'success', collapsible: true });
    const serialized = JSON.stringify(completed);
    expect(serialized).toContain('SELECT sum(amt)');
    expect(serialized).toContain('number');
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('"value":2');
  });

  it('creates validated View and optimistic-concurrency Undo actions for learned context', () => {
    const processed = new EventProcessor().processEvent(
      event('event-3', 'call-2', {
        type: 'data_context_learned',
        status: 'completed',
        sourceId: sourceFixture().id,
        sourceName: 'Production Sales',
        summaries: ['st = 2 means paid', 'amt is in cents'],
        priorRevision: 3,
        currentRevision: 4,
      })
    );
    expect(processed?.actions?.[0].href).toContain('view=data-sources');
    expect(processed?.actions?.[0].href).toContain('tab=context');
    expect(processed?.actions?.[1]).toMatchObject({
      service: 'dataSources.revertContext',
      params: { targetRevision: 3, expectedCurrentRevision: 4 },
    });
  });

  it('gives the model a flexible capability-driven analysis contract', () => {
    expect(DATA_ANALYSIS_PROMPT).toContain('tool_search');
    expect(DATA_ANALYSIS_PROMPT).toContain('multiple calls');
    expect(DATA_ANALYSIS_PROMPT).toContain('multiple sources');
    expect(DATA_ANALYSIS_PROMPT).toContain('data_describe');
    expect(DATA_ANALYSIS_PROMPT).toContain('per-call safety boundary');
    expect(DATA_ANALYSIS_PROMPT).toContain('aggregate');
    expect(DATA_ANALYSIS_PROMPT).toContain('source timezone');
    expect(DATA_ANALYSIS_PROMPT).toContain('Do not retry a timeout');
    expect(DATA_ANALYSIS_PROMPT).toContain('at most two');
    expect(DATA_ANALYSIS_PROMPT).toContain('truncation reasons');
    expect(DATA_ANALYSIS_PROMPT).toContain('never present a sample or partial result as complete');
    expect(DATA_ANALYSIS_PROMPT).toContain('Stop instead of guessing');
    expect(DATA_ANALYSIS_PROMPT).toContain('concrete pipeline blueprint');
    expect(DATA_ANALYSIS_PROMPT).toContain('Preserve unknowns as unknowns');
    expect(DATA_ANALYSIS_PROMPT).toContain('available execution path');
    expect(DATA_ANALYSIS_PROMPT).toContain('data_learn_context');
    expect(DATA_ANALYSIS_PROMPT).not.toContain('CREATE TABLE');
  });

  it('describes the single-statement boundary as per invocation', () => {
    if (DATA_QUERY_TOOL.type !== 'function') throw new Error('data_query must be a function tool');
    expect(DATA_QUERY_TOOL.function.description).toContain('per invocation');
    expect(DATA_QUERY_TOOL.function.description).toContain('multiple invocations');
  });
});
