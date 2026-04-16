/**
 * HookDispatcher — Single entry-point for firing hooks.
 *
 * Owns matching → sync/async split → execution → aggregation → once cleanup.
 * Emits hook observability events through the BrowserX event flow.
 * Call sites use `fire(event, input)` and never touch lower-level pieces directly.
 */

import type { EventMsg } from '../protocol/events';
import type {
  HookEvent,
  HookInput,
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
}

/** Callback to emit EventMsg into the BrowserX event pipeline. */
export type HookEventEmitter = (msg: EventMsg) => void;

/**
 * No-op result returned when no hooks match, avoiding unnecessary allocations.
 */
const EMPTY_RESULT: AggregatedHookResult = Object.freeze({
  shouldContinue: true,
  additionalContext: Object.freeze([]) as readonly string[],
  systemMessages: Object.freeze([]) as readonly string[],
  results: Object.freeze([]) as readonly any[],
  totalDuration: 0,
});

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
    // Fast path: no hooks registered for this event at all
    if (!this.registry.hasHooksFor(event)) {
      return EMPTY_RESULT;
    }

    const matching = this.registry.getMatchingHooks(
      event,
      input.tool_name,
      input.tool_input as Record<string, unknown> | undefined,
    );

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
      this.fireAndForget(hook, input, options?.signal);
    }

    // Execute sync hooks in parallel and aggregate
    let aggregated: AggregatedHookResult;
    if (syncHooks.length === 0) {
      aggregated = EMPTY_RESULT;
    } else {
      const results = await Promise.all(
        syncHooks.map((hook) => {
          const cmd =
            options?.timeoutOverride !== undefined
              ? { ...hook.command, timeout: options.timeoutOverride }
              : hook.command;
          return this.executor.execute(cmd, input, options?.signal);
        }),
      );
      aggregated = HookAggregator.aggregate(results);
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

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private fireAndForget(
    hook: RegisteredHook,
    input: HookInput,
    signal?: AbortSignal,
  ): void {
    this.executor.execute(hook.command, input, signal).catch((err) => {
      console.warn(
        `[HookDispatcher] Async hook ${hook.id} failed:`,
        err instanceof Error ? err.message : err,
      );
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
}
