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
} from './types';

/**
 * SubAgentRunner spawns and manages sub-agent executions.
 * Uses RepublicAgentEngine for execution and SubAgentRegistry for tracking.
 *
 * Implements prepare/execute/cleanup pipeline (IAgentRunner interface).
 */
export class SubAgentRunner implements IAgentRunner {
  private readonly registry: SubAgentRegistry;
  private readonly parentEngine: RepublicAgentEngine;
  private readonly customTypes: Map<string, SubAgentTypeConfig>;

  constructor(options: {
    parentEngine: RepublicAgentEngine;
    registry?: SubAgentRegistry;
    customTypes?: SubAgentTypeConfig[];
  }) {
    this.parentEngine = options.parentEngine;
    this.registry = options.registry ?? new SubAgentRegistry();
    this.customTypes = new Map();

    // Register built-in types
    for (const type of BUILTIN_SUBAGENT_TYPES) {
      this.customTypes.set(type.id, type);
    }

    // Register custom types
    if (options.customTypes) {
      for (const type of options.customTypes) {
        this.customTypes.set(type.id, type);
      }
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

    // Background: detach. Inject task notification on settle; cleanup runs
    // only after the detached promise resolves (success or failure).
    void this.execute(context, params)
      .then((result) => {
        context.parentEngine.enqueueSyntheticUserTurn(
          this.formatTaskNotification(context, params, result),
        );
      })
      .catch((error) => {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        context.parentEngine.enqueueSyntheticUserTurn(
          this.formatTaskNotification(context, params, {
            success: false,
            response: '',
            turnCount: 0,
            stopReason: 'error',
            error: errorMsg,
          }),
        );
      })
      .finally(() => {
        void this.cleanup(context);
      });

    return {
      status: 'launched',
      runId: context.runId,
      type: params.type,
      description: params.description ?? params.prompt.slice(0, 50),
    };
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
    });

    // Phase 1.2: Parent-lifecycle cancellation
    let abortController: AbortController;
    let unsubscribe: (() => void) | undefined;

    if (background) {
      // Background agents: independent AbortController with no linkage
      abortController = new AbortController();
    } else {
      // Foreground agents: linked AbortController
      abortController = new AbortController();

      if (params.signal) {
        params.signal.addEventListener(
          'abort',
          () => abortController.abort(),
          { once: true }
        );
      }

      unsubscribe = this.parentEngine.onEvent((event) => {
        if (event.msg.type === 'EngineDisposed') {
          abortController.abort();
        }
      });
    }

    // Atomically check concurrency and register — prevents TOCTOU race
    try {
      this.registry.register({
        runId,
        type: params.type,
        description: params.description ?? params.prompt.slice(0, 50),
        parentSessionId: this.parentEngine.engineId,
        engine,
        startTime,
        status: 'running',
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

    return {
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
      console.warn(`[SubAgentRunner] Error disposing engine for run ${context.runId}:`, disposeError);
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
   * Get all available sub-agent types.
   */
  getTypes(): SubAgentTypeConfig[] {
    return Array.from(this.customTypes.values());
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
    return this.customTypes.get(typeId);
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
   */
  private formatTaskNotification(
    context: AgentContext,
    params: SubAgentToolParams,
    result: AgentRunResult,
  ): string {
    const durationMs = Date.now() - context.startTime;
    const status: 'completed' | 'failed' | 'cancelled' = result.success
      ? 'completed'
      : result.stopReason === 'cancelled' || result.stopReason === 'interrupted'
        ? 'cancelled'
        : 'failed';

    const lines: string[] = [];
    lines.push('<task-notification>');
    lines.push(`  <run-id>${escapeXml(context.runId)}</run-id>`);
    lines.push(`  <type>${escapeXml(params.type)}</type>`);
    lines.push(`  <status>${status}</status>`);
    lines.push(
      `  <summary>${escapeXml(params.description ?? params.type)}</summary>`,
    );
    if (result.response) {
      lines.push(`  <result>${escapeXml(result.response)}</result>`);
    }
    if (result.error) {
      lines.push(`  <error>${escapeXml(result.error)}</error>`);
    }
    lines.push('  <usage>');
    if (result.tokenUsage) {
      lines.push(
        `    <total_tokens>${result.tokenUsage.total}</total_tokens>`,
      );
    }
    lines.push(`    <turn_count>${result.turnCount}</turn_count>`);
    lines.push(`    <duration_ms>${durationMs}</duration_ms>`);
    lines.push('  </usage>');
    lines.push('</task-notification>');
    return lines.join('\n');
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
