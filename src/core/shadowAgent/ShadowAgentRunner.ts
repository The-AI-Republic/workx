import { createChildToolRegistry } from '@/tools/ToolRegistryCloner';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { EngineEvent } from '@/core/engine/RepublicAgentEngineConfig';
import { getShadowAgentProfile } from './builtins';
import { buildShadowInitialHistory } from './ShadowAgentContext';
import { createShadowAgentEvent, errorToMessage } from './ShadowAgentEvents';
import {
  ShadowFailurePolicy,
  type ShadowAgentRequest,
  type ShadowAgentResolvedRequest,
  type ShadowAgentResult,
  type ShadowToolPolicy,
} from './types';

export class ShadowAgentRunner {
  private readonly parentEngine: RepublicAgentEngine;

  constructor(options: { parentEngine: RepublicAgentEngine }) {
    this.parentEngine = options.parentEngine;
  }

  resolveRequest(request: ShadowAgentRequest, runId: string = crypto.randomUUID()): ShadowAgentResolvedRequest {
    const profile = getShadowAgentProfile(request.kind);
    return {
      ...request,
      runId,
      parentEngine: request.parentEngine ?? this.parentEngine,
      profile,
      systemPrompt: request.systemPrompt ?? defaultSystemPrompt(request.kind),
      contextPolicy: request.contextPolicy ?? profile.defaultContextPolicy,
      toolPolicy: mergeToolPolicy(profile.toolPolicy, request.toolPolicy),
      maxTurns: request.maxTurns ?? profile.maxTurns,
      priority: request.priority ?? profile.defaultPriority,
      queuePolicy: request.queuePolicy ?? profile.queuePolicy,
      failurePolicy: request.failurePolicy ?? profile.failurePolicy,
      timeoutMs: request.timeoutMs ?? profile.timeoutMs,
    };
  }

  async run(request: ShadowAgentRequest, options?: { runId?: string; abortSignal?: AbortSignal }): Promise<ShadowAgentResult> {
    const resolved = this.resolveRequest(request, options?.runId);
    const startedAt = Date.now();
    let childEngine: RepublicAgentEngine | undefined;

    this.emit('ShadowAgentStarted', resolved, {
      status: undefined,
      timeout_ms: resolved.timeoutMs,
      metadata: resolved.metadata,
    });

    try {
      const parentRegistry = resolved.parentEngine.getToolRegistry();
      const childRegistry = await createChildToolRegistry(
        parentRegistry,
        resolved.toolPolicy,
        { childKind: 'shadow_agent' },
      );
      const { initialHistory } = buildShadowInitialHistory(resolved);

      childEngine = resolved.parentEngine.createChildEngine({
        toolRegistry: childRegistry,
        systemPrompt: resolved.systemPrompt,
        model: resolved.model,
        maxTurns: resolved.maxTurns,
        approvalPolicy: resolved.profile.approvalPolicy ?? 'never',
        initialHistory,
      });
      await childEngine.initialize();

      const signal = combineAbortSignals(options?.abortSignal, resolved.abortSignal);
      const result = await childEngine.run(
        [{ type: 'text', text: resolved.prompt }],
        { signal, timeoutMs: resolved.timeoutMs },
      );

      const durationMs = Date.now() - startedAt;
      if (result.success) {
        const completed: ShadowAgentResult = {
          kind: resolved.kind,
          status: 'completed',
          outputText: result.response ?? undefined,
          usage: result.tokenUsage,
          durationMs,
          runId: resolved.runId,
          childEngineId: childEngine.engineId,
        };
        this.emit('ShadowAgentCompleted', resolved, {
          status: completed.status,
          duration_ms: durationMs,
          child_engine_id: childEngine.engineId,
        });
        return completed;
      }

      const status = result.stopReason === 'cancelled' || signal?.aborted
        ? 'cancelled'
        : result.stopReason === 'interrupted'
          ? 'cancelled'
          : result.error?.toLowerCase().includes('timed out')
            ? 'timed_out'
            : 'failed';
      const failed = await this.handleFailure(
        resolved,
        result.error ?? result.stopReason,
        durationMs,
        childEngine.engineId,
        status,
      );
      return failed;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const status = isAbortLike(error, options?.abortSignal, resolved.abortSignal)
        ? 'cancelled'
        : isTimeoutLike(error)
          ? 'timed_out'
          : 'failed';
      return this.handleFailure(resolved, error, durationMs, childEngine?.engineId, status);
    } finally {
      if (childEngine) {
        await Promise.resolve(childEngine.dispose()).catch(() => undefined);
      }
    }
  }

  private async handleFailure(
    request: ShadowAgentResolvedRequest,
    error: unknown,
    durationMs: number,
    childEngineId: string | undefined,
    status: 'failed' | 'cancelled' | 'timed_out',
  ): Promise<ShadowAgentResult> {
    if (request.failurePolicy === ShadowFailurePolicy.Fallback) {
      const fallbackOutput = await request.fallback?.(error);
      if (fallbackOutput !== undefined) {
        const fallbackResult: ShadowAgentResult = {
          kind: request.kind,
          status: 'fallback_used',
          outputText: fallbackOutput,
          fallbackOutputText: fallbackOutput,
          error,
          durationMs,
          runId: request.runId,
          childEngineId,
        };
        this.emit('ShadowAgentFallbackUsed', request, {
          status: fallbackResult.status,
          duration_ms: durationMs,
          child_engine_id: childEngineId,
          error: errorToMessage(error),
        });
        return fallbackResult;
      }
    }

    const result: ShadowAgentResult = {
      kind: request.kind,
      status,
      error,
      durationMs,
      runId: request.runId,
      childEngineId,
    };

    const eventType = status === 'cancelled'
      ? 'ShadowAgentCancelled'
      : status === 'timed_out'
        ? 'ShadowAgentTimedOut'
        : 'ShadowAgentFailed';
    this.emit(eventType, request, {
      status,
      duration_ms: durationMs,
      child_engine_id: childEngineId,
      error: errorToMessage(error),
    });

    if (request.failurePolicy === ShadowFailurePolicy.Throw) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (request.failurePolicy === ShadowFailurePolicy.LogAndSuppress) {
      console.warn('[ShadowAgentRunner] shadow job failed:', request.kind, errorToMessage(error));
    }

    return result;
  }

  private emit(
    type: Parameters<typeof createShadowAgentEvent>[0],
    request: ShadowAgentResolvedRequest,
    data: Partial<EngineEvent['msg']['data']> & Record<string, unknown>,
  ): void {
    try {
      request.parentEngine.pushEvent(createShadowAgentEvent(type, {
        run_id: request.runId,
        kind: request.kind,
        priority: request.priority,
        timeout_ms: request.timeoutMs,
        failure_policy: request.failurePolicy,
        parent_engine_id: request.parentEngine.engineId,
        dedupe_key: request.dedupeKey,
        model: request.model,
        ...data,
      } as any));
    } catch (error) {
      console.warn('[ShadowAgentRunner] event emit failed:', errorToMessage(error));
    }
  }
}

function mergeToolPolicy(base: ShadowToolPolicy, override?: ShadowToolPolicy): ShadowToolPolicy {
  return {
    allow: override?.allow ?? base.allow,
    deny: [...(base.deny ?? []), ...(override?.deny ?? [])],
    preExecuteCheck: override?.preExecuteCheck ?? base.preExecuteCheck,
    exact: override?.exact ?? base.exact,
  };
}

function defaultSystemPrompt(kind: string): string {
  return `You are an internal BrowserX shadow agent for ${kind}. Complete only the delegated runtime task and return concise output.`;
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  // Remove the listener from the *other* signal when either fires, so a
  // long-lived caller-provided signal does not accumulate one dead listener
  // per shadow run.
  const onAbort = () => {
    controller.abort();
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
  };
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function isAbortLike(error: unknown, ...signals: Array<AbortSignal | undefined>): boolean {
  return signals.some((signal) => signal?.aborted)
    || (error instanceof Error && /cancel|abort|interrupt/i.test(error.message));
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}
