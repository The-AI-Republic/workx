// File: src/tools/AgentTool/types.ts

/**
 * Configuration for a sub-agent type.
 * Defines how a sub-agent behaves and what tools it has access to.
 */
export interface SubAgentTypeConfig {
  /** Unique identifier for this sub-agent type */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of when to use this sub-agent */
  description: string;

  /** System prompt for this sub-agent type */
  systemPrompt: string;

  /**
   * Tool access control.
   *
   * - `allow` only: only the listed tools are available (allowlist).
   * - `deny` only: all parent tools except the listed ones are available (denylist).
   * - Both: `allow` is applied first to select tools, then `deny` removes from that set.
   * - Neither: all parent tools are available (minus `sub_agent` which is always denied).
   */
  tools?: {
    /** If set, only these tools are available (allowlist). Applied first. */
    allow?: string[];
    /** If set, these tools are removed (denylist). Applied after allow filter. */
    deny?: string[];
  };

  /** Model override. If omitted, inherits parent's model */
  model?: string;

  /** Max turns before forced stop. Must be >= 1. Default: 25 */
  maxTurns?: number;

  /**
   * Approval policy for tool execution.
   * - `'never'`: auto-approve all tool calls (default for sub-agents)
   * - `'inherit'`: use the parent agent's approval gate (prompts user for risky tools)
   */
  approvalPolicy?: 'never' | 'inherit';

  /** Event types to suppress when routing to parent */
  suppressedEvents?: string[];
}

/**
 * Parameters for the sub_agent tool call (what the LLM provides)
 */
export interface SubAgentToolParams {
  /** Which sub-agent type to invoke */
  type: string;

  /** The task/prompt to send to the sub-agent */
  prompt: string;

  /** Short description of what the sub-agent will do */
  description?: string;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;

  /** Whether to run this sub-agent in the background */
  background?: boolean;
}

/**
 * Result returned from a sub-agent execution
 */
export interface SubAgentResult {
  /** Whether the sub-agent completed successfully */
  success: boolean;

  /** The sub-agent's final text response */
  response: string;

  /** Unique ID for this sub-agent run */
  runId: string;

  /** Token usage */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  /** Number of turns taken */
  turnCount: number;

  /** Why the sub-agent stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';

  /** Error message if stopReason is 'error' */
  error?: string;
}

/**
 * Context for an agent execution pipeline.
 * Created by prepare(), consumed by execute() and cleanup().
 */
export interface AgentContext {
  runId: string;
  engine: import('@/core/engine/RepublicAgentEngine').RepublicAgentEngine;
  abortController: AbortController;
  registry: import('./SubAgentRegistry').SubAgentRegistry;
  typeConfig: SubAgentTypeConfig;
  parentEngine: import('@/core/engine/RepublicAgentEngine').RepublicAgentEngine;
  background: boolean;
  startTime: number;
  /** Cleanup function for event listeners */
  unsubscribe?: () => void;
}

/**
 * Result from agent execution (internal, maps to SubAgentResult for tool output).
 */
export interface AgentRunResult {
  success: boolean;
  response: string;
  turnCount: number;
  tokenUsage?: { input: number; output: number; total: number };
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';
  error?: string;
}

/**
 * Agent execution pipeline interface.
 * Sub-agents implement this now; teammates could implement it later.
 */
export interface IAgentRunner {
  prepare(params: SubAgentToolParams): Promise<AgentContext>;
  execute(context: AgentContext, params: SubAgentToolParams): Promise<AgentRunResult>;
  cleanup(context: AgentContext): Promise<void>;
}

/** Token usage for a single sub-agent run */
export interface SubAgentUsageEntry {
  runId: string;
  type: string;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregate token usage across sub-agent runs */
export interface SubAgentUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  byAgent: SubAgentUsageEntry[];
}

/** Notification from a completed background sub-agent */
export interface TaskNotification {
  runId: string;
  type: string;
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: string;
  tokenUsage?: { input: number; output: number; total: number };
  turnCount: number;
  durationMs: number;
  error?: string;
}

/** Result returned immediately when a background sub-agent is launched */
export interface BackgroundSubAgentResult {
  status: 'launched';
  runId: string;
  type: string;
  description: string;
}
