/**
 * Track 05b: integration test for the compaction interlock.
 *
 * Asserts that:
 *  - compact() awaits any in-flight session-summary extraction
 *  - compact() folds the (non-empty) summary into generateSummaryWithModel
 *  - compact() emits compact_skipped_empty_summary when the summary is empty
 *  - compact() emits compact_extraction_wait_timeout when the wait deadline hits
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompactService } from '../CompactService';
import {
  _resetExtractionLifecycleForTests,
  markExtractionCompleted,
  markExtractionStarted,
} from '../../sessionSummary/extractionLifecycle';
import { SESSION_SUMMARY_TEMPLATE } from '../../sessionSummary/template';
import type { SessionSummaryHook } from '../../sessionSummary/SessionSummaryHook';
import type { ResponseItem } from '../../protocol/types';
import type { ModelClient } from '../../models/ModelClient';
import { ShadowAgentKind, type ShadowAgentScheduler } from '../../shadowAgent';

vi.mock('../../models/types/ResponseEvent', () => ({
  isOutputTextDelta: (event: { type: string }) => event.type === 'output_text_delta',
  isCompleted: (event: { type: string }) => event.type === 'completed',
}));

vi.mock('../constants', () => ({
  SUMMARIZATION_PROMPT: 'Summarize.',
  SUMMARY_PREFIX: '[SUMMARY]',
  NO_SUMMARY_PLACEHOLDER: '(none)',
  TRUNCATION_MARKER: '\n[trunc]',
  DEFAULT_COMPACTION_CONFIG: {
    triggerThreshold: 0.85,
    userMessageBudget: 20000,
    maxRetries: 1,
    baseBackoffMs: 1,
  },
}));

vi.mock('../utils', async (orig) => {
  const actual = await orig<typeof import('../utils')>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

function userMsg(text: string): ResponseItem {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

function asstMsg(text: string): ResponseItem {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/**
 * Build a ModelClient mock whose stream emits one output_text_delta then a
 * `completed` event. Captures the prompt text so we can assert about hint
 * folding.
 */
function makeStreamingModel(capturedPrompts: string[]): ModelClient {
  return {
    stream: vi.fn(async (req: { input: ResponseItem[] }) => {
      const last = req.input[req.input.length - 1];
      if (
        last &&
        last.type === 'message' &&
        Array.isArray(last.content) &&
        last.content[0]?.type === 'input_text'
      ) {
        capturedPrompts.push((last.content[0] as { text: string }).text);
      }
      return (async function* () {
        yield { type: 'output_text_delta', delta: 'mock summary text' };
        yield { type: 'completed' };
      })();
    }),
  } as unknown as ModelClient;
}

function makeMockHook(opts: {
  summaryOnDisk?: string;
}): SessionSummaryHook & { telemetryEvents: Array<{ event: string; payload: unknown }> } {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    readSummaryFromDisk: vi.fn(async () => opts.summaryOnDisk ?? ''),
    emitTelemetry: vi.fn((event: string, payload: unknown) => {
      events.push({ event, payload });
    }),
    telemetryEvents: events,
    // We don't construct the full class here; cast to satisfy the type.
  } as unknown as SessionSummaryHook & {
    telemetryEvents: Array<{ event: string; payload: unknown }>;
  };
}

describe('CompactService — Track 05b interlock', () => {
  beforeEach(() => {
    _resetExtractionLifecycleForTests();
  });

  afterEach(() => {
    _resetExtractionLifecycleForTests();
    vi.useRealTimers();
  });

  it('folds a non-empty summary into the summarization prompt', async () => {
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const hook = makeMockHook({
      summaryOnDisk:
        SESSION_SUMMARY_TEMPLATE.replace(
          '_URLs the agent navigated to during this session._',
          '_URLs the agent navigated to during this session._\n- example.com',
        ),
    });

    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];

    const result = await service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      sessionSummaryHook: hook,
    });

    expect(result.success).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('<session_summary>');
    expect(captured[0]).toContain('example.com');

    // Telemetry: compact_with_summary emitted
    const events = (hook as unknown as { telemetryEvents: Array<{ event: string }> }).telemetryEvents;
    expect(events.some((e) => e.event === 'compact_with_summary')).toBe(true);
  });

  it('emits compact_skipped_empty_summary when the summary file is empty/template', async () => {
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const hook = makeMockHook({ summaryOnDisk: SESSION_SUMMARY_TEMPLATE });

    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];

    await service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      sessionSummaryHook: hook,
    });

    // No hint folded in
    expect(captured[0]).not.toContain('<session_summary>');

    const events = (hook as unknown as { telemetryEvents: Array<{ event: string }> }).telemetryEvents;
    expect(events.some((e) => e.event === 'compact_skipped_empty_summary')).toBe(true);
  });

  it('waits for an in-flight extraction to complete before compacting', async () => {
    vi.useFakeTimers();
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const hook = makeMockHook({});

    markExtractionStarted('s-1');

    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];
    const promise = service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      sessionSummaryHook: hook,
    });

    // Stream model.stream must NOT have been called yet — we're blocked on wait.
    expect(model.stream).not.toHaveBeenCalled();

    markExtractionCompleted('s-1');
    // Advance the polling timer.
    await vi.advanceTimersByTimeAsync(1100);
    await promise;

    expect(model.stream).toHaveBeenCalledTimes(1);
  });

  it('emits compact_extraction_wait_timeout when the 15s deadline expires', async () => {
    vi.useFakeTimers();
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const hook = makeMockHook({});

    markExtractionStarted('s-1');

    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];
    const promise = service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      sessionSummaryHook: hook,
    });

    // Blow past the 15s deadline (but stay under the 60s staleness escape).
    await vi.advanceTimersByTimeAsync(16_000);
    await promise;

    const events = (hook as unknown as { telemetryEvents: Array<{ event: string }> }).telemetryEvents;
    expect(events.some((e) => e.event === 'compact_extraction_wait_timeout')).toBe(true);
  });

  it('falls back gracefully when extras is omitted (back-compat path)', async () => {
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];

    // No extras — should behave exactly like the old signature.
    const result = await service.compact(history, 'auto', model, 100);
    expect(result.success).toBe(true);
    expect(captured[0]).not.toContain('<session_summary>');
  });

  it('folds an opt-in shadow compaction note into the direct compaction prompt', async () => {
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];
    const shadowScheduler = {
      run: vi.fn(async () => ({
        kind: ShadowAgentKind.Compact,
        status: 'completed',
        outputText: 'shadow note about earlier state',
        durationMs: 1,
        runId: 'shadow-compact',
      })),
    } as unknown as ShadowAgentScheduler;

    const result = await service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      shadowScheduler,
      enableShadowPrepare: true,
    });

    expect(result.success).toBe(true);
    expect(shadowScheduler.run).toHaveBeenCalledTimes(1);
    expect(captured[0]).toContain('shadow note about earlier state');
  });

  it('uses direct compaction when opt-in shadow preparation fails', async () => {
    const service = new CompactService();
    const captured: string[] = [];
    const model = makeStreamingModel(captured);
    const history: ResponseItem[] = [userMsg('hi'), asstMsg('there')];
    const shadowScheduler = {
      run: vi.fn(async () => {
        throw new Error('shadow unavailable');
      }),
    } as unknown as ShadowAgentScheduler;

    const result = await service.compact(history, 'auto', model, 100, undefined, {
      sessionId: 's-1',
      shadowScheduler,
      enableShadowPrepare: true,
    });

    expect(result.success).toBe(true);
    expect(captured[0]).toBe('Summarize.');
  });
});
