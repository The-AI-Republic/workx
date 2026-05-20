import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CompactService } from '@/core/compact/CompactService';
import type { ModelClient } from '@/core/models/ModelClient';
import type { ResponseItem } from '@/core/protocol/types';
import type { FileSystem } from '@/core/memory/types';
import {
  _resetExtractionLifecycleForTests,
  isExtractionInFlight,
} from '../extractionLifecycle';
import { SessionSummaryHook } from '../SessionSummaryHook';
import { getSessionSummaryPath } from '../SessionSummaryFileStore';
import { ShadowAgentKind, type ShadowAgentResult } from '@/core/shadowAgent';

vi.mock('@/core/PromptLoader', () => ({
  registerPromptExtension: vi.fn(),
  unregisterPromptExtension: vi.fn(),
}));

class NodeTempFs implements FileSystem {
  async readFile(p: string): Promise<string> {
    return fs.readFile(p, 'utf-8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }

  async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function bigHistory(): ResponseItem[] {
  const out: ResponseItem[] = [];
  for (let i = 0; i < 200; i++) {
    out.push({
      type: 'message',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{
        type: i % 2 === 0 ? 'input_text' : 'output_text',
        text: `turn ${i} ${'x'.repeat(600)}`,
      } as any],
    });
  }
  return out;
}

function makeStreamingModel(capturedPrompts: string[]): ModelClient {
  return {
    stream: vi.fn(async (req: { input: ResponseItem[] }) => {
      const last = req.input[req.input.length - 1];
      if (
        last?.type === 'message' &&
        Array.isArray(last.content) &&
        last.content[0]?.type === 'input_text'
      ) {
        capturedPrompts.push((last.content[0] as { text: string }).text);
      }
      return (async function* () {
        yield { type: 'OutputTextDelta', delta: 'deterministic compact summary' };
        yield { type: 'Completed', responseId: 'compact-response' };
      })();
    }),
  } as unknown as ModelClient;
}

describe('session summary e2e loop', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    _resetExtractionLifecycleForTests();
    for (const root of tempRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('triggers extraction, writes summary.md, waits during compaction, and folds summary into prompt', async () => {
    _resetExtractionLifecycleForTests();
    const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'browserx-summary-e2e-'));
    tempRoots.push(memoryRoot);
    const nodeFs = new NodeTempFs();
    const sessionId = 'session-e2e';
    const summaryPath = getSessionSummaryPath(memoryRoot, sessionId);
    const extractionStarted = createDeferred<void>();
    const releaseExtraction = createDeferred<void>();
    const telemetryEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

    const engine = {
      pushEvent: vi.fn(),
      getShadowAgentScheduler: vi.fn(() => ({
        run: vi.fn(async (request: any): Promise<ShadowAgentResult> => {
          extractionStarted.resolve();
          await releaseExtraction.promise;
          await nodeFs.writeFile(
            request.metadata.summaryPath,
            '# Session Summary\n\n## Key Facts\n\n- user selected the deterministic e2e path\n',
          );
          return {
            kind: ShadowAgentKind.SessionSummary,
            status: 'completed',
            durationMs: 1,
            runId: 'summary-e2e',
          };
        }),
      })),
    } as unknown as import('@/core/engine/RepublicAgentEngine').RepublicAgentEngine;

    const hook = new SessionSummaryHook({
      sessionId,
      parentEngine: engine,
      fs: nodeFs,
      memoryRoot,
      telemetry: {
        emit: (event, payload) => telemetryEvents.push({ event, payload }),
      },
    });

    let postTurnHook!: (ctx: Parameters<SessionSummaryHook['handlePostTurn']>[0]) => Promise<void>;
    await hook.attach((fn) => {
      postTurnHook = fn;
      return () => undefined;
    });

    const history = bigHistory();
    await postTurnHook({
      sessionId,
      history,
      lastTurnHadToolCalls: false,
    });
    await extractionStarted.promise;

    expect(isExtractionInFlight(sessionId)).toBe(true);
    await expect(nodeFs.readFile(summaryPath)).resolves.not.toContain('deterministic e2e path');

    const capturedPrompts: string[] = [];
    const model = makeStreamingModel(capturedPrompts);
    const compactPromise = new CompactService({ baseBackoffMs: 1, maxRetries: 1 }).compact(
      history,
      'auto',
      model,
      20000,
      undefined,
      { sessionId, sessionSummaryHook: hook },
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(model.stream).not.toHaveBeenCalled();

    releaseExtraction.resolve();
    const compactResult = await compactPromise;

    expect(compactResult.success).toBe(true);
    await expect(nodeFs.readFile(summaryPath)).resolves.toContain('deterministic e2e path');
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain('<session_summary>');
    expect(capturedPrompts[0]).toContain('deterministic e2e path');
    expect(telemetryEvents.some(e => e.event === 'compact_with_summary')).toBe(true);

    hook.detach();
  });
});
