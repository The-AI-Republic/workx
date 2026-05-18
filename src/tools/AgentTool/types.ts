// File: src/tools/AgentTool/types.ts

import type {
  AgentType,
  SubAgentContextMode,
  SubAgentExecutionMode,
} from './agentTypes';
import type { ResolvedSubAgentBehavior } from './behavior';

/**
 * Configuration for a sub-agent type.
 * Defines how a sub-agent behaves and what tools it has access to.
 */
export interface SubAgentTypeConfig {
  /** Unique identifier for this sub-agent type */
  id: string;

  /** Enum-backed runtime behavior type. Registration id remains dynamic. */
  agentType?: AgentType;

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

  /** Default context mode for this type. Defaults to isolated. */
  defaultContextMode?: SubAgentContextMode;

  /** Allowed context modes. Defaults depend on agentType. */
  allowedContextModes?: SubAgentContextMode[];
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

  /** Whether the child starts isolated or with a fork of parent history */
  contextMode?: SubAgentContextMode;

  /** Additional per-invocation hard allow-list inherited from a skill. */
  allowedTools?: readonly string[];

  /**
   * When `background: true`, suppress the synthetic `<task-notification>`
   * that is normally injected into the parent's pending input on completion.
   *
   * Deprecated for internal runtime jobs. Use ShadowAgentScheduler so quiet
   * work does not enter sub-agent task state at all. Kept for compatibility
   * with existing background sub-agent behavior.
   *
   * @deprecated Internal quiet jobs should use ShadowAgentScheduler.
   */
  quietBackground?: boolean;

  /**
   * Optional synchronous pre-execute gate installed on the child tool
   * registry. Runs BEFORE the approval gate, so it gates calls that the
   * sub-agent's `approvalPolicy: 'never'` would otherwise auto-approve.
   *
   * Used by internal extractors (session summary) to constrain `file_edit`
   * to a single allowed path. Defence-in-depth on top of
   * `SubAgentTypeConfig.tools.allow`.
   *
   * @internal Track 05b
   */
  canUseTool?: import('../ToolRegistry').PreExecuteCheck;
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
  /**
   * Mutable: set to true by `cancel_sub_agent` (or any external cancellation
   * path) before disposing the engine. When true, the detached background
   * handler suppresses the `<task-notification>` injection — the caller of
   * `cancel_sub_agent` already received explicit confirmation, so a second
   * notification would be redundant noise to the parent LLM.
   */
  cancelled?: boolean;

  /** Resolved behavior profile for this run */
  behavior: ResolvedSubAgentBehavior;

  /** Effective context mode for this run */
  contextMode: SubAgentContextMode;

  /** Effective foreground/background mode for this run */
  executionMode: SubAgentExecutionMode;
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
  agentType?: AgentType;
  contextMode?: SubAgentContextMode;
  executionMode?: SubAgentExecutionMode;
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: string;
  /**
   * Canonical Track 04 token-usage shape. cached optional for models that
   * support prompt caching. total is stored to avoid re-summing.
   */
  tokenUsage?: { input: number; output: number; cached?: number; total: number };
  turnCount: number;
  durationMs: number;
  error?: string;
  /**
   * (Track 04) Last chunk seq in TaskOutputStore when the notification
   * fires. Parent agent can use this to pick up additional chunks via
   * engine.getTaskOutput(runId, outputOffset). Absent when the task wrote
   * no chunks (foreground, or sub-agent without taskOutputStore wired).
   */
  outputOffset?: number;
}

/** Result returned immediately when a background sub-agent is launched */
export interface BackgroundSubAgentResult {
  /**
   * Literal discriminant. Use `'kind' in result && result.kind === 'background'`
   * to narrow `SubAgentResult | BackgroundSubAgentResult` — more robust than
   * checking for `'status' in result`, which would silently break if
   * `SubAgentResult` ever gained a `status` field.
   */
  kind: 'background';
  status: 'launched';
  runId: string;
  type: string;
  description: string;
}

/**
 * Type guard for narrowing the `sub_agent` tool's union return type.
 */
export function isBackgroundSubAgentResult(
  r: SubAgentResult | BackgroundSubAgentResult,
): r is BackgroundSubAgentResult {
  return 'kind' in r && r.kind === 'background';
}
