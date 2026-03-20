// File: src/core/subagent/SubAgentRunner.ts

import { RepublicAgentEngine } from '../engine/RepublicAgentEngine';
import type { InputItem } from '../engine/RepublicAgentEngineConfig';
import { SubAgentEventRouter } from '../events/SubAgentEventRouter';
import { createSubAgentToolRegistry } from '../../tools/ToolRegistryCloner';
import { SubAgentRegistry } from './SubAgentRegistry';
import { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
import type { SubAgentTypeConfig, SubAgentToolParams, SubAgentResult } from './types';

/**
 * SubAgentRunner spawns and manages sub-agent executions.
 * Uses RepublicAgentEngine for execution and SubAgentRegistry for tracking.
 */
export class SubAgentRunner {
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
   * Run a sub-agent to completion.
   */
  async run(params: SubAgentToolParams): Promise<SubAgentResult> {
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

    const runId = crypto.randomUUID();
    const startTime = Date.now();

    // Create restricted tool registry
    const childRegistry = await createSubAgentToolRegistry(
      this.parentEngine.getToolRegistry(),
      typeConfig
    );

    // Create event router for namespaced events
    const eventRouter = new SubAgentEventRouter({
      parentEmitter: (event) => this.parentEngine.pushEvent(event),
      engineId: runId,
      suppressedTypes: typeConfig.suppressedEvents,
    });

    const parentConfig = this.parentEngine.getConfig();
    const parentSession = this.parentEngine.getSession();
    const approvalGate = typeConfig.approvalPolicy === 'inherit'
      ? this.parentEngine.getToolRegistry().getApprovalGate()
      : undefined;
    const approvalPolicy = typeConfig.approvalPolicy === 'inherit'
      ? parentSession?.getTurnContext?.().getApprovalPolicy?.() ?? 'on-request'
      : 'never';

    // Create child engine via parent's factory method
    const engine = this.parentEngine.createChildEngine({
      toolRegistry: childRegistry,
      systemPrompt: typeConfig.systemPrompt,
      model: typeConfig.model ?? parentConfig.model,
      maxTurns: typeConfig.maxTurns ?? 25,
      approvalPolicy,
      approvalGate,
      browserContext: parentConfig.browserContext,
      eventRouter,
    });

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
      return {
        success: false,
        response: '',
        runId,
        turnCount: 0,
        stopReason: 'error',
        error: 'Max concurrent sub-agents reached',
      };
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

    try {
      await engine.initialize();

      const input: InputItem[] = [{ type: 'text', text: params.prompt }];
      const result = await engine.run(input, {
        maxTurns: typeConfig.maxTurns,
        signal: params.signal,
      });

      this.registry.updateStatus(runId, result.success ? 'completed' : 'failed');

      // Emit completion event
      this.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentComplete',
          data: {
            runId,
            subAgentType: params.type,
            turnCount: result.turnCount,
            tokenUsage: result.tokenUsage ? {
              input: result.tokenUsage.input_tokens,
              output: result.tokenUsage.output_tokens,
              total: result.tokenUsage.total_tokens,
            } : undefined,
            duration: Date.now() - startTime,
          },
        },
      });

      return {
        success: result.success,
        response: result.response ?? '',
        runId,
        turnCount: result.turnCount,
        tokenUsage: result.tokenUsage ? {
          input: result.tokenUsage.input_tokens,
          output: result.tokenUsage.output_tokens,
          total: result.tokenUsage.total_tokens,
        } : undefined,
        stopReason: result.stopReason === 'completed' ? 'completed'
          : result.stopReason === 'max_turns' ? 'max_turns'
          : result.stopReason === 'cancelled' ? 'cancelled'
          : result.stopReason === 'interrupted' ? 'interrupted'
          : 'error',
        error: result.error,
      };
    } catch (error) {
      this.registry.updateStatus(runId, 'failed');

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Emit error event
      this.parentEngine.pushEvent({
        id: crypto.randomUUID(),
        msg: {
          type: 'SubAgentError',
          data: {
            runId,
            subAgentType: params.type,
            error: errorMsg,
          },
        },
      });

      return {
        success: false,
        response: '',
        runId,
        turnCount: 0,
        stopReason: 'error',
        error: errorMsg,
      };
    } finally {
      try {
        await engine.dispose();
      } catch (disposeError) {
        console.warn(`[SubAgentRunner] Error disposing engine for run ${runId}:`, disposeError);
      }
      this.registry.unregister(runId);
    }
  }

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

  private resolveType(typeId: string): SubAgentTypeConfig | undefined {
    return this.customTypes.get(typeId);
  }
}
