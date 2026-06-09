/**
 * HookDispatcher — Single entry-point for firing hooks.
 *
 * Owns matching → sync/async split → execution → aggregation → once cleanup.
 * Emits hook observability events through the WorkX event flow.
 * Call sites use `fire(event, input)` and never touch lower-level pieces directly.
 */

import type { EventMsg } from '../protocol/events';
import type {
  HookEvent,
  HookInput,
  HookResult,
  AggregatedHookResult,
  RegisteredHook,
} from './types';
import { HookRegistry } from './HookRegistry';
import { HookExecutor } from './HookExecutor';
import { HookAggregator } from './HookAggregator';

/** Options for a single fire() call. */
export interface HookFireOptions {
  /** AbortSignal to cancel all hooks. */
  signal?: AbortSignal;
  /** Override the default timeout for all hooks in this call (seconds). */
  timeoutOverride?: number;
  /** Frozen hook generation for one tool execution. */
  snapshot?: HookExecutionSnapshot;
}

/** Callback to emit EventMsg into the WorkX event pipeline. */
export type HookEventEmitter = (msg: EventMsg) => void;

export interface HookExecutionSnapshot {
  getMatchingHooks(event: HookEvent): RegisteredHook[];
}

/**
 * No-op result returned when no hooks match, avoiding unnecessary allocations.
 */
const EMPTY_RESULT: AggregatedHookResult = Object.freeze({
  shouldContinue: true,
  additionalContext: Object.freeze([]) as readonly string[],
  systemMessages: Object.freeze([]) as readonly string[],
  results: Object.freeze([]) as readonly HookResult[],
  totalDuration: 0,
});

const TOOL_EXECUTION_HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
];

export class HookDispatcher {
  private readonly registry: HookRegistry;
  private readonly executor: HookExecutor;
  private eventEmitter: HookEventEmitter | null = null;

  constructor(registry: HookRegistry, executor: HookExecutor) {
    this.registry = registry;
    this.executor = executor;
  }

  /**
   * Set the event emitter for hook observability events.
   */
  setEventEmitter(emitter: HookEventEmitter): void {
    this.eventEmitter = emitter;
  }

  /**
   * Get the underlying registry (for external registration).
   */
  getRegistry(): HookRegistry {
    return this.registry;
  }

  createToolExecutionSnapshot(
    toolName: string,
    toolInput?: Record<string, unknown>,
  ): HookExecutionSnapshot {
    const hooksByEvent = new Map<HookEvent, RegisteredHook[]>();
    for (const event of TOOL_EXECUTION_HOOK_EVENTS) {
      hooksByEvent.set(
        event,
        this.registry.getMatchingHooks(event, toolName, toolInput),
      );
    }

    return {
      getMatchingHooks(event: HookEvent): RegisteredHook[] {
        return [...(hooksByEvent.get(event) ?? [])];
      },
    };
  }

  /**
   * Fire all matching hooks for an event.
   *
   * - Sync hooks (async !== true) are awaited and aggregated.
   * - Async hooks (async === true) are fire-and-forget.
   * - `once` hooks are removed after execution.
   *
   * Returns the aggregated result from sync hooks only.
   */
  async fire(
    event: HookEvent,
    input: HookInput,
    options?: HookFireOptions,
  ): Promise<AggregatedHookResult> {
    const matching = options?.snapshot
      ? options.snapshot.getMatchingHooks(event)
      : this.getLiveMatchingHooks(event, input);

    if (matching.length === 0) {
      return EMPTY_RESULT;
    }

    // Split sync vs async
    const syncHooks: RegisteredHook[] = [];
    const asyncHooks: RegisteredHook[] = [];
    for (const hook of matching) {
      if (hook.command.async) {
        asyncHooks.push(hook);
      } else {
        syncHooks.push(hook);
      }
    }

    // Fire async hooks (fire-and-forget)
    for (const hook of asyncHooks) {
      this.fireAndForget(hook, input, options?.signal, options?.timeoutOverride);
    }

    // Execute sync hooks in parallel and aggregate.
    // Use allSettled so one failing hook doesn't cancel the rest.
    let aggregated: AggregatedHookResult;
    if (syncHooks.length === 0) {
      aggregated = EMPTY_RESULT;
    } else {
      const settled = await Promise.allSettled(
        syncHooks.map((hook) => {
          const cmd =
            options?.timeoutOverride !== undefined
              ? { ...hook.command, timeout: options.timeoutOverride }
              : hook.command;
          return this.executor.execute(cmd, input, options?.signal);
        }),
      );
      const results: HookResult[] = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : {
              hookId: `failed_${syncHooks[i].id}`,
              outcome: 'non_blocking_error' as const,
              stderr:
                s.reason instanceof Error
                  ? s.reason.message
                  : String(s.reason),
              duration: 0,
            },
      );
      aggregated = HookAggregator.aggregate(results);
      results.forEach((result, idx) => {
        const hook = syncHooks[idx];
        if (hook) this.emitHookResult(event, input, hook, result);
      });
    }

    // Remove `once` hooks (both sync and async)
    for (const hook of matching) {
      if (hook.command.once) {
        this.registry.unregister(hook.id);
      }
    }

    // Emit observability events
    this.emitObservability(event, input, matching, aggregated);

    return aggregated;
  }

  private getLiveMatchingHooks(event: HookEvent, input: HookInput): RegisteredHook[] {
    // Fast path: no hooks registered for this event at all
    if (!this.registry.hasHooksFor(event)) {
      return [];
    }

    return this.registry.getMatchingHooks(
      event,
      input.tool_name,
      input.tool_input as Record<string, unknown> | undefined,
    );
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private fireAndForget(
    hook: RegisteredHook,
    input: HookInput,
    signal?: AbortSignal,
    timeoutOverride?: number,
  ): void {
    const cmd =
      timeoutOverride !== undefined
        ? { ...hook.command, timeout: timeoutOverride }
        : hook.command;
    this.executor.execute(cmd, input, signal).then((result) => {
      this.emitHookResult(hook.event, input, hook, result);
    }).catch((err) => {
      console.warn(
        `[HookDispatcher] Async hook ${hook.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      this.emitHookResult(hook.event, input, hook, {
        hookId: `failed_${hook.id}`,
        outcome: 'non_blocking_error',
        stderr: err instanceof Error ? err.message : String(err),
        duration: 0,
      });
    });
  }

  private emitObservability(
    event: HookEvent,
    input: HookInput,
    hooks: readonly RegisteredHook[],
    aggregated: AggregatedHookResult,
  ): void {
    if (!this.eventEmitter) return;

    // HookFired — one event per fire() call summarizing what ran
    this.eventEmitter({
      type: 'HookFired',
      data: {
        hook_event_name: event,
        hook_count: hooks.length,
        tool_name: input.tool_name,
      },
    });

    // HookBlocked — only if hooks blocked execution
    if (!aggregated.shouldContinue) {
      this.eventEmitter({
        type: 'HookBlocked',
        data: {
          hook_event_name: event,
          tool_name: input.tool_name,
          stop_reason: aggregated.stopReason,
        },
      });
    }
  }

  private emitHookResult(
    event: HookEvent,
    input: HookInput,
    hook: RegisteredHook,
    result: HookResult,
  ): void {
    if (!this.eventEmitter) return;
    const error = result.stderr || result.stdout;
    this.eventEmitter({
      type: 'HookResult',
      data: {
        hook_event_name: event,
        hook_id: hook.id,
        execution_id: result.hookId,
        source: this.sourceToString(hook.source),
        command_type: hook.command.type,
        outcome: result.outcome,
        duration_ms: result.duration,
        tool_name: input.tool_name,
        exit_code: result.exitCode,
        blocked: result.outcome === 'blocking_error' || result.continue === false,
        permission_decision: result.decision,
        updated_input: result.updatedInput !== undefined,
        updated_output: result.updatedOutput !== undefined,
        additional_context: result.additionalContext !== undefined,
        error: error ? this.truncate(error, 240) : undefined,
      },
    });
  }

  private sourceToString(source: RegisteredHook['source']): string {
    return typeof source === 'string'
      ? source
      : `${source.type}:${source.pluginId}`;
  }

  private truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}...`;
  }
}
