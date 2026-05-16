// File: src/tools/AgentTool/SubAgentRunner.ts

import { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { InputItem } from '@/core/engine/RepublicAgentEngineConfig';
import { SubAgentEventRouter } from '@/core/events/SubAgentEventRouter';
import { createSubAgentToolRegistry } from '../ToolRegistryCloner';
import { SubAgentRegistry } from './SubAgentRegistry';
import { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
import type {
  SubAgentTypeConfig,
  SubAgentToolParams,
  SubAgentResult,
  BackgroundSubAgentResult,
  AgentContext,
  AgentRunResult,
  IAgentRunner,
  TaskNotification,
} from './types';
import type { BackgroundAgentTaskState } from '@/core/tasks/types';
import { PANEL_GRACE_MS } from '@/core/tasks/timing';
import { assertValidSubAgentTypeConfig } from './validateTypeConfig';

/**
 * Source tag for sub-agent type registrations. Used by the plugin port
 * (Track 10) to scope removals by plugin owner without affecting builtin
 * or config-supplied types.
 */
export type SubAgentTypeSource =
  | { type: 'builtin' }
  | { type: 'config' }
  | { type: 'plugin'; pluginId: string };

/**
 * SubAgentRunner spawns and manages sub-agent executions.
 * Uses RepublicAgentEngine for execution and SubAgentRegistry for tracking.
 *
 * Implements prepare/execute/cleanup pipeline (IAgentRunner interface).
 *
 * Track 10: types are mutable at runtime. Call `addType` / `removeByPluginId`
 * for plugin-driven mutations; wire `setTypesChangedCallback(fn)` so the
 * outer registration layer (registerSubAgentTool) can rebuild the
 * `sub_agent` tool definition via `ToolRegistry.replace`.
 */
export class SubAgentRunner implements IAgentRunner {
  private readonly registry: SubAgentRegistry;
  private readonly parentEngine: RepublicAgentEngine;
  // Track 10: mutable types map (was readonly customTypes)
  private readonly types: Map<string, SubAgentTypeConfig>;
  // Track 10: plugin ownership index for scoped removal
  private readonly pluginTypeIndex: Map<string, Set<string>>;
  // Track 10: reverse index (typeId → owning pluginId) for plugin-owned
  // types only. Lets addType reject collisions with builtin/config types
  // or another plugin's id, and lets removeByPluginId delete only ids it
  // still owns (never a builtin that happens to share the id).
  private readonly pluginTypeOwner: Map<string, string>;
  // Track 10: callback fired when types change at runtime (after initial construction)
  private onTypesChanged: (() => Promise<void>) | null = null;

  constructor(options: {
    parentEngine: RepublicAgentEngine;
    registry?: SubAgentRegistry;
    customTypes?: SubAgentTypeConfig[];
  }) {
    this.parentEngine = options.parentEngine;
    this.registry = options.registry ?? new SubAgentRegistry();
    this.types = new Map();
    this.pluginTypeIndex = new Map();
    this.pluginTypeOwner = new Map();

    // Register built-in types
    for (const type of BUILTIN_SUBAGENT_TYPES) {
      this.types.set(type.id, type);
    }

    // Register custom types (from constructor — typically config-sourced)
    if (options.customTypes) {
      for (const type of options.customTypes) {
        this.types.set(type.id, type);
      }
    }
    // No onTypesChanged fires during construction — the outer
    // registerSubAgentTool builds the initial tool definition itself.
  }

  /**
   * Track 10: wire a callback that fires after every runtime type change
   * (`addType` / `removeByPluginId`). The callback typically rebuilds the
   * `sub_agent` tool definition and replaces it in the engine's tool
   * registry via `ToolRegistry.replace`.
   *
   * Called by `registerSubAgentTool` after the initial tool registration.
   */
  setTypesChangedCallback(cb: (() => Promise<void>) | null): void {
    this.onTypesChanged = cb;
  }

  /**
   * Track 10: add a new sub-agent type at runtime.
   *
   * Plugin source carries `pluginId` for scoped removal via
   * `removeByPluginId`. Fires the types-changed callback so the outer
   * registration layer can rebuild the `sub_agent` tool definition.
   *
   * A plugin-sourced type may NOT reuse an id already held by a builtin,
   * a config-supplied type, or a *different* plugin — that would let a
   * later `removeByPluginId` silently delete the shadowed type. Such a
   * collision throws so the plugin loader surfaces it in
   * `LoadedPlugin.errors` (consistent with `assertValidSubAgentTypeConfig`).
   * Re-adding under the same pluginId is allowed (update-in-place).
   *
   * NOTE: Phase 10a-1 ships eager rebuild on every addType. Phase 10a-2
   * will add an active-task guard (defer until TaskCompleted) per design
   * § Active-Session Semantics Rule 2 to prevent the LLM seeing an
   * in-turn schema swap.
   */
  async addType(config: SubAgentTypeConfig, source: SubAgentTypeSource): Promise<void> {
    assertValidSubAgentTypeConfig(config);
    if (source.type === 'plugin') {
      const owner = this.pluginTypeOwner.get(config.id);
      if (owner === undefined && this.types.has(config.id)) {
        throw new Error(
          `Plugin '${source.pluginId}' cannot register sub-agent type '${config.id}': ` +
            `id is already held by a builtin or config-supplied type`,
        );
      }
      if (owner !== undefined && owner !== source.pluginId) {
        throw new Error(
          `Plugin '${source.pluginId}' cannot register sub-agent type '${config.id}': ` +
            `id is already owned by plugin '${owner}'`,
        );
      }
      this.types.set(config.id, config);
      let set = this.pluginTypeIndex.get(source.pluginId);
      if (!set) {
        set = new Set();
        this.pluginTypeIndex.set(source.pluginId, set);
      }
      set.add(config.id);
      this.pluginTypeOwner.set(config.id, source.pluginId);
    } else {
      this.types.set(config.id, config);
    }
    if (this.onTypesChanged) {
      await this.onTypesChanged();
    }
  }

  /**
   * Track 10: scoped removal — remove every type owned by a given plugin.
   * Called by `PluginRegistry.disable(pluginId)`. Builtin and config-sourced
   * types are unaffected (no pluginId).
   */
  async removeByPluginId(pluginId: string): Promise<void> {
    const typeIds = this.pluginTypeIndex.get(pluginId);
    if (!typeIds || typeIds.size === 0) return;
    for (const id of typeIds) {
      // Only drop ids this plugin still owns — never a builtin/other type
      // that happens to share the id (addType's guard makes this defensive).
      if (this.pluginTypeOwner.get(id) === pluginId) {
        this.types.delete(id);
        this.pluginTypeOwner.delete(id);
      }
    }
    this.pluginTypeIndex.delete(pluginId);
    if (this.onTypesChanged) {
      await this.onTypesChanged();
    }
  }

  /**
   * Run a sub-agent.
   *
   * Foreground (default): awaits execution and returns the final result.
   * Background: starts execution in a detached promise and returns immediately
   * with `{ status: 'launched', runId, ... }`. When the detached run completes
   * (success/failure/cancel), a `<task-notification>` is injected into the
   * parent engine's pending input so the parent LLM sees the outcome on its
   * next turn.
   */
  async run(
    params: SubAgentToolParams,
  ): Promise<SubAgentResult | BackgroundSubAgentResult> {
    // Early validation
    const typeConfig = this.resolveType(params.type);
    if (!typeConfig) {
      return {
        success: false,
        response: '',
        runId: '',
        turnCount: 0,
        stopReason: 'error',
        error: `Unknown sub-agent type: ${params.type}`,
      };
    }

    // Validate maxTurns
    if (typeConfig.maxTurns !== undefined && typeConfig.maxTurns < 1) {
      return {
        success: false,
        response: '',
        runId: '',
        turnCount: 0,
        stopReason: 'error',
        error: `Invalid maxTurns (${typeConfig.maxTurns}) for sub-agent type: ${params.type}`,
      };
    }

    let context: AgentContext;
    try {
      context = await this.prepare(params, typeConfig);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        response: '',
        runId: '',
        turnCount: 0,
        stopReason: 'error',
        error: errorMsg,
      };
    }

    if (!context.background) {
      // Foreground: await result, cleanup before returning to caller.
      try {
        const result = await this.execute(context, params);
        return this.toSubAgentResult(context, result);
      } finally {
        await this.cleanup(context);
      }
    }

    // Background: detach. Wrapped in an async IIFE so cleanup rejections and
    // notification throws are all observable inside a single try/catch/finally.
    // Skip the notification entirely when context.cancelled is true — the
    // operator who called cancel_sub_agent already received explicit
    // confirmation; a second notification would be redundant noise.
    //
    // `quietBackground: true` (Track 05b) suppresses the notification too —
    // used by internal extractors (session summary) where the parent LLM
    // should never see the bookkeeping completion event.
    const suppressNotification = (): boolean =>
      context.cancelled === true || params.quietBackground === true;

    void (async () => {
      try {
        const result = await this.execute(context, params);
        if (!suppressNotification()) {
          this.safeEnqueueNotification(
            context,
            this.formatTaskNotification(context, params, result),
          );
          // (Track 04) Update typed state to terminal on parent session.
          this.markTypedTaskTerminated(context, result);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!suppressNotification()) {
          const failed: AgentRunResult = {
            success: false,
            response: '',
            turnCount: 0,
            stopReason: 'error',
            error: errorMsg,
          };
          this.safeEnqueueNotification(
            context,
            this.formatTaskNotification(context, params, failed),
          );
          this.markTypedTaskTerminated(context, failed);
        }
      } finally {
        try {
          await this.cleanup(context);
        } catch (cleanupError) {
          // Surface as an event so consumers have visibility; never let it
          // become an unhandled rejection on the detached promise chain.
          context.parentEngine.pushEvent({
            id: crypto.randomUUID(),
            msg: {
              type: 'SubAgentError',
              data: {
                runId: context.runId,
                subAgentType: params.type,
                error: `cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              },
            },
          });
        }
      }
    })();

    return {
      kind: 'background',
      status: 'launched',
      runId: context.runId,
      type: params.type,
      description: params.description ?? params.prompt.slice(0, 50),
    };
  }

  /**
   * Inject a notification into the parent engine, swallowing any throw so it
   * cannot poison the detached background chain. Errors are surfaced as events.
   */
  /**
   * (Track 04) Mark the typed BackgroundAgentTaskState terminal on the
   * parent session and record final telemetry (status, tokens, tools,
   * endTime). The Session's eviction timer takes over from here; the
   * RunningTask entry stays in activeTasks until the grace window expires.
   */
  private markTypedTaskTerminated(context: AgentContext, result: AgentRunResult): void {
    const parentSession = context.parentEngine.getSession?.();
    if (!parentSession?.getTask) return;
    const entry = parentSession.getTask(context.runId);
    if (!entry?.taskState) return;
    const ts = entry.taskState;
    if (ts.status !== 'pending' && ts.status !== 'running') return;
    ts.status = result.success
      ? 'completed'
      : (result.stopReason === 'cancelled' || result.stopReason === 'interrupted')
        ? 'killed'
        : 'failed';
    ts.endTime = Date.now();
    ts.notified = true; // safeEnqueueNotification just ran (or was suppressed)
    if (result.tokenUsage) {
      ts.tokenUsage = {
        input: result.tokenUsage.input ?? 0,
        output: result.tokenUsage.output ?? 0,
        total: result.tokenUsage.total ?? 0,
      };
    }
    ts.toolUseCount = result.turnCount ?? ts.toolUseCount;
    if (result.response) {
      ts.lastAgentMessage = result.response;
    }
    // Re-arm evictAfter if not retained.
    if (!ts.retain) {
      ts.evictAfter = Date.now() + PANEL_GRACE_MS;
    }
    // Kick the eviction timer; ensureEvictionTimer is private but
    // onTaskFinished/onTaskAborted normally start it. Touch a no-op
    // helper to nudge: trigger one tick by calling retainTask(false).
    parentSession.retainTask?.(context.runId, ts.retain);
  }

  private safeEnqueueNotification(context: AgentContext, text: string): void {
    try {
      context.parentEngine.enqueueSyntheticUserTurn(text);
    } catch (error) {
      context.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            runId: context.runId,
            subAgentType: context.typeConfig.id,
            error: `notification enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // IAgentRunner: prepare
  // ---------------------------------------------------------------------------

  /**
   * Prepare an AgentContext for execution.
   * Creates restricted tool registry, event router, child engine, and registers
   * with SubAgentRegistry.
   */
  async prepare(params: SubAgentToolParams, typeConfig?: SubAgentTypeConfig): Promise<AgentContext> {
    const resolvedTypeConfig = typeConfig ?? this.resolveType(params.type);
    if (!resolvedTypeConfig) {
      throw new Error(`Unknown sub-agent type: ${params.type}`);
    }

    // Phase 1.1: Recursion depth enforcement
    if (this.parentEngine.getDepth() >= this.parentEngine.getMaxDepth()) {
      throw new Error(`Max sub-agent depth (${this.parentEngine.getMaxDepth()}) reached`);
    }

    const runId = crypto.randomUUID();
    const startTime = Date.now();
    const background = params.background ?? false;

    // Create restricted tool registry
    const childRegistry = await createSubAgentToolRegistry(
      this.parentEngine.getToolRegistry(),
      resolvedTypeConfig
    );

    // Track 05b: install an optional sync pre-execute gate on the child
    // registry. Runs BEFORE the approval gate so it constrains calls that
    // `approvalPolicy: 'never'` would otherwise auto-approve. Used by
    // internal extractors to lock `file_edit` to a single allowed path.
    if (params.canUseTool) {
      childRegistry.setPreExecuteCheck(params.canUseTool);
    }

    // Create event router for namespaced events
    const eventRouter = new SubAgentEventRouter({
      parentEmitter: (event) => this.parentEngine.pushEvent(event),
      engineId: runId,
      suppressedTypes: resolvedTypeConfig.suppressedEvents,
    });

    const parentConfig = this.parentEngine.getConfig();
    const parentSession = this.parentEngine.getSession();

    // Default to 'inherit' when approvalPolicy is not explicitly set.
    // Only 'never' explicitly opts out of approval — prevents accidental bypass.
    // Background runs cannot prompt the user (parent has moved on), so force 'never'
    // regardless of the type's configured policy.
    const effectiveApprovalPolicy = background
      ? 'never'
      : (resolvedTypeConfig.approvalPolicy ?? 'inherit');
    const approvalGate = effectiveApprovalPolicy === 'inherit'
      ? this.parentEngine.getToolRegistry().getApprovalGate()
      : undefined;
    const approvalPolicy = effectiveApprovalPolicy === 'inherit'
      ? parentSession?.getTurnContext?.().getApprovalPolicy?.() ?? 'on-request'
      : 'never';

    // Create child engine via parent's factory method
    const engine = this.parentEngine.createChildEngine({
      toolRegistry: childRegistry,
      systemPrompt: resolvedTypeConfig.systemPrompt,
      model: resolvedTypeConfig.model ?? parentConfig.model,
      maxTurns: resolvedTypeConfig.maxTurns ?? 25,
      approvalPolicy,
      approvalGate,
      browserContext: parentConfig.browserContext,
      eventRouter,
      drainPendingMessages: () => this.registry.drainMessages(runId),
      // (Track 04) Inherit parent's output store so the child's TaskRunner
      // can persist chunks. RegularTask in the child session reads
      // session.getTaskOutputStore() when wiring AgentTask -> TaskRunner.
      taskOutputStore: parentSession?.getTaskOutputStore?.() ?? undefined,
    });

    // Phase 1.2: Parent-lifecycle cancellation
    const abortController = new AbortController();
    let unsubscribe: (() => void) | undefined;

    if (!background) {
      // Foreground agents: link to params.signal and parent EngineDisposed.
      if (params.signal) {
        // Handle already-aborted signal — addEventListener would never fire.
        if (params.signal.aborted) {
          abortController.abort();
        } else {
          params.signal.addEventListener(
            'abort',
            () => abortController.abort(),
            { once: true },
          );
        }
      }

      unsubscribe = this.parentEngine.onEvent((event) => {
        if (event.msg.type !== 'EngineDisposed') return;
        abortController.abort();
      });
    } else if (params.signal !== undefined) {
      // Background runs intentionally outlive the caller's signal — surface
      // this surprise as an event so the caller knows their signal is inert.
      this.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentWarning',
          data: {
            runId,
            subAgentType: params.type,
            warning: 'background: true ignores params.signal — use cancel_sub_agent to terminate.',
          },
        },
      });
    }

    const context: AgentContext = {
      runId,
      engine,
      abortController,
      registry: this.registry,
      typeConfig: resolvedTypeConfig,
      parentEngine: this.parentEngine,
      background,
      startTime,
      unsubscribe,
    };

    // Atomically check concurrency and register — prevents TOCTOU race.
    // Passing context lets cancel_sub_agent set context.cancelled before
    // disposing the engine, so the detached handler can skip the duplicate
    // task-notification.
    try {
      this.registry.register({
        runId,
        type: params.type,
        description: params.description ?? params.prompt.slice(0, 50),
        parentSessionId: this.parentEngine.engineId,
        engine,
        startTime,
        status: 'running',
        context,
      });
    } catch {
      // Clean up unsubscribe on registration failure
      if (unsubscribe) {
        unsubscribe();
      }

      // Emit error event so lifecycle consumers have visibility
      this.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            runId,
            subAgentType: params.type,
            error: 'Max concurrent sub-agents reached',
          },
        },
      });
      throw new Error('Max concurrent sub-agents reached');
    }

    // Emit start event
    this.parentEngine.pushEvent({
      id: crypto.randomUUID(),
      msg: {
        type: 'SubAgentStart',
        data: {
          runId,
          subAgentType: params.type,
          description: params.description ?? params.prompt.slice(0, 50),
        },
      },
    });

    // (Track 04) Build typed BackgroundAgentTaskState and register on
    // parent session. Identity collapse: runId === taskState.id.
    // The parent session creates a synthetic RunningTask entry tied to
    // this sub-agent's AbortController + context so per-task abort,
    // tab-scoped abort, and eviction all work.
    const parentSessionForRegistry = parentSession;
    if (parentSessionForRegistry && typeof parentSessionForRegistry.registerTaskState === 'function') {
      const description = params.description ?? params.prompt.slice(0, 50);
      const taskState: BackgroundAgentTaskState = {
        id: runId,
        type: 'background_agent',
        status: 'running',
        description,
        startTime,
        outputOffset: 0,
        notified: false,
        isBackgrounded: background,
        retain: false,
        runId,
        parentSessionId: this.parentEngine.engineId,
        prompt: params.prompt,
        toolUseCount: 0,
        tokenUsage: { input: 0, output: 0, total: 0 },
      };
      parentSessionForRegistry.registerTaskState(taskState, {
        context,
        abortController,
        scopedTabIds: parentConfig.browserContext?.tabId !== undefined
          ? [parentConfig.browserContext.tabId]
          : undefined,
      });
    }

    return context;
  }

  // ---------------------------------------------------------------------------
  // IAgentRunner: execute
  // ---------------------------------------------------------------------------

  /**
   * Run the sub-agent engine to completion.
   * Maps EngineResult to AgentRunResult and records usage.
   */
  async execute(context: AgentContext, params: SubAgentToolParams): Promise<AgentRunResult> {
    try {
      await context.engine.initialize();

      const input: InputItem[] = [{ type: 'text', text: params.prompt }];
      const result = await context.engine.run(input, {
        maxTurns: context.typeConfig.maxTurns,
        signal: context.abortController.signal,
      });

      const tokenUsage = result.tokenUsage ? {
        input: result.tokenUsage.input_tokens,
        output: result.tokenUsage.output_tokens,
        total: result.tokenUsage.total_tokens,
      } : undefined;

      // Update registry status
      context.registry.updateStatus(
        context.runId,
        result.success ? 'completed' : 'failed'
      );

      // Emit completion event
      context.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentComplete',
          data: {
            runId: context.runId,
            subAgentType: params.type,
            turnCount: result.turnCount,
            tokenUsage,
            duration: Date.now() - context.startTime,
          },
        },
      });

      // Phase 1.3: Record token usage
      if (tokenUsage) {
        context.registry.recordUsage({
          runId: context.runId,
          type: params.type,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
        });
      }

      return {
        success: result.success,
        response: result.response ?? '',
        turnCount: result.turnCount,
        tokenUsage,
        stopReason: result.stopReason === 'completed' ? 'completed'
          : result.stopReason === 'max_turns' ? 'max_turns'
          : result.stopReason === 'cancelled' ? 'cancelled'
          : result.stopReason === 'interrupted' ? 'interrupted'
          : 'error',
        error: result.error,
      };
    } catch (error) {
      context.registry.updateStatus(context.runId, 'failed');

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Emit error event
      context.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            runId: context.runId,
            subAgentType: params.type,
            error: errorMsg,
          },
        },
      });

      return {
        success: false,
        response: '',
        turnCount: 0,
        stopReason: 'error',
        error: errorMsg,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // IAgentRunner: cleanup
  // ---------------------------------------------------------------------------

  /**
   * Dispose engine and clean up resources.
   * For foreground agents, unregisters from registry.
   * For background agents, keeps entry for management tools.
   */
  async cleanup(context: AgentContext): Promise<void> {
    try {
      await context.engine.dispose();
    } catch (disposeError) {
      context.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            runId: context.runId,
            subAgentType: context.typeConfig.id,
            error: `engine dispose failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
          },
        },
      });
    }

    // Call unsubscribe if set (foreground event listener cleanup)
    if (context.unsubscribe) {
      context.unsubscribe();
    }

    if (!context.background) {
      // Foreground: unregister from registry
      context.registry.unregister(context.runId);
    }
    // Background: keep entry for management tools
  }

  // ---------------------------------------------------------------------------
  // Public accessors (preserve existing API)
  // ---------------------------------------------------------------------------

  /**
   * Get the sub-agent registry for status queries.
   */
  getRegistry(): SubAgentRegistry {
    return this.registry;
  }

  /**
   * Get all available sub-agent types (builtins + config + custom + plugin).
   */
  getTypes(): SubAgentTypeConfig[] {
    return Array.from(this.types.values());
  }

  /**
   * Cancel all running sub-agents.
   */
  async cancelAll(): Promise<void> {
    await this.registry.cancelAll();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveType(typeId: string): SubAgentTypeConfig | undefined {
    return this.types.get(typeId);
  }

  /**
   * Map an AgentRunResult to a SubAgentResult for tool output.
   */
  private toSubAgentResult(context: AgentContext, result: AgentRunResult): SubAgentResult {
    return {
      success: result.success,
      response: result.response,
      runId: context.runId,
      turnCount: result.turnCount,
      tokenUsage: result.tokenUsage,
      stopReason: result.stopReason,
      error: result.error,
    };
  }

  /**
   * Format a completed background run as a `<task-notification>` block to be
   * injected into the parent engine's pending input. The parent LLM sees this
   * on its next turn.
   *
   * Status mapping: success → 'completed'; stopReason 'cancelled' or
   * 'interrupted' → 'cancelled'; anything else → 'failed'.
   *
   * The notification is built as a `TaskNotification` value first, then
   * serialized — so any future field added to the interface fails to compile
   * until the formatter is updated.
   */
  private formatTaskNotification(
    context: AgentContext,
    params: SubAgentToolParams,
    result: AgentRunResult,
  ): string {
    const status: TaskNotification['status'] = result.success
      ? 'completed'
      : result.stopReason === 'cancelled' || result.stopReason === 'interrupted'
        ? 'cancelled'
        : 'failed';

    // (Track 04) Capture output offset from the parent session's typed
    // state so the parent agent can delta-poll any chunks written after
    // the notification was assembled.
    const parentSession = context.parentEngine.getSession?.();
    const taskState = parentSession?.getTask?.(context.runId)?.taskState;
    const outputOffset = taskState?.outputOffset && taskState.outputOffset > 0
      ? taskState.outputOffset
      : undefined;

    const notification: TaskNotification = {
      runId: context.runId,
      type: params.type,
      description: params.description ?? params.type,
      status,
      result: result.response || undefined,
      error: result.error,
      tokenUsage: result.tokenUsage,
      turnCount: result.turnCount,
      durationMs: Date.now() - context.startTime,
      outputOffset,
    };

    return serializeTaskNotification(notification);
  }
}

/**
 * Sanitize an LLM-visible text value before it appears between XML-like tags.
 *
 * The notification is consumed by an LLM, not by a strict XML parser. Beyond
 * basic XML entity escaping, we also disarm the literal opening-/closing-tag
 * sequences for the notification's own envelope and nested elements, so a
 * sub-agent's response cannot inject a fake `</task-notification>` boundary
 * that the parent LLM might pattern-match as end-of-message.
 */
function escapeForLlmXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeTaskNotification(n: TaskNotification): string {
  const lines: string[] = [];
  lines.push('<task-notification>');
  lines.push(`  <run-id>${escapeForLlmXml(n.runId)}</run-id>`);
  lines.push(`  <type>${escapeForLlmXml(n.type)}</type>`);
  lines.push(`  <status>${n.status}</status>`);
  lines.push(`  <summary>${escapeForLlmXml(n.description)}</summary>`);
  if (n.result) {
    lines.push(`  <result>${escapeForLlmXml(n.result)}</result>`);
  }
  if (n.error) {
    lines.push(`  <error>${escapeForLlmXml(n.error)}</error>`);
  }
  lines.push('  <usage>');
  if (n.tokenUsage) {
    lines.push(`    <input_tokens>${n.tokenUsage.input}</input_tokens>`);
    lines.push(`    <output_tokens>${n.tokenUsage.output}</output_tokens>`);
    if (n.tokenUsage.cached !== undefined) {
      lines.push(`    <cached_tokens>${n.tokenUsage.cached}</cached_tokens>`);
    }
    lines.push(`    <total_tokens>${n.tokenUsage.total}</total_tokens>`);
  }
  lines.push(`    <turn_count>${n.turnCount}</turn_count>`);
  lines.push(`    <duration_ms>${n.durationMs}</duration_ms>`);
  lines.push('  </usage>');
  // (Track 04) Optional element — present only when the sub-agent's
  // TaskRunner persisted chunks. Parent agent can call
  // engine.getTaskOutput(run-id, outputOffset) to fetch tail bytes.
  if (n.outputOffset !== undefined) {
    lines.push(`  <output-offset>${n.outputOffset}</output-offset>`);
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}
