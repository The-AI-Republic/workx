// File: src/core/subagent/types.ts

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

  /** Whether this type always runs in background. Default: false */
  background?: boolean;

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

  /** Run in background. Default: false */
  background?: boolean;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;
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
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled';

  /** Error message if stopReason is 'error' */
  error?: string;
}
