import { createChildToolRegistry } from '@/tools/ToolRegistryCloner';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { ShadowAgentRuntimeEventData } from '@/core/protocol/events';
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

    // Deterministic timeout: our own controller + timer so that the
    // timed_out vs. failed classification does not depend on the engine's
    // error-message wording. Also fully links/unlinks the caller signals so
    // a long-lived signal never accumulates a listener per run.
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer =
      resolved.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, resolved.timeoutMs)
        : undefined;
    const link = linkAbortSignals(
      options?.abortSignal,
      resolved.abortSignal,
      timeoutController.signal,
    );

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

      const result = await childEngine.run(
        [{ type: 'text', text: resolved.prompt }],
        { signal: link.signal, timeoutMs: resolved.timeoutMs },
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

      // Our own timeout takes precedence: when the timer fired the combined
      // signal is aborted too, so timedOut MUST be checked before the
      // abort/cancel branches.
      const status = timedOut
        ? 'timed_out'
        : result.stopReason === 'cancelled' ||
            isExternallyAborted(options?.abortSignal, resolved.abortSignal)
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
      const status = timedOut
        ? 'timed_out'
        : isAbortLike(error, options?.abortSignal, resolved.abortSignal)
          ? 'cancelled'
          : isTimeoutLike(error)
            ? 'timed_out'
            : 'failed';
      return this.handleFailure(resolved, error, durationMs, childEngine?.engineId, status);
    } finally {
      if (timer) clearTimeout(timer);
      link.dispose();
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
    data: Partial<ShadowAgentRuntimeEventData>,
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
      }));
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

/**
 * Combine N abort signals into one, and return an explicit `dispose()` that
 * detaches every listener. `dispose()` is called on every run completion
 * path (success, failure, timeout) so a long-lived caller-provided signal
 * never accumulates a dead listener per shadow run.
 */
function linkAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): { signal: AbortSignal | undefined; dispose: () => void } {
  const real = signals.filter((s): s is AbortSignal => Boolean(s));
  if (real.length === 0) return { signal: undefined, dispose: () => undefined };
  if (real.length === 1) return { signal: real[0], dispose: () => undefined };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const dispose = () => {
    for (const s of real) s.removeEventListener('abort', onAbort);
  };

  if (real.some((s) => s.aborted)) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  for (const s of real) s.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, dispose };
}

function isExternallyAborted(...signals: Array<AbortSignal | undefined>): boolean {
  return signals.some((signal) => signal?.aborted);
}

function isAbortLike(error: unknown, ...signals: Array<AbortSignal | undefined>): boolean {
  return signals.some((signal) => signal?.aborted)
    || (error instanceof Error && /cancel|abort|interrupt/i.test(error.message));
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}
