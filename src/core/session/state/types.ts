/**
 * Shared types for state management
 */

import type { ReviewDecision } from '../../../protocol/types';

/**
 * Kind of task running in an active turn
 */
export enum TaskKind {
  /** Regular task execution */
  Regular = 'Regular',
  /** Task awaiting user review/approval */
  Review = 'Review',
  /** Compact mode task */
  Compact = 'Compact',
}

/**
 * A running task in an active turn
 */
export interface RunningTask {
  /** Kind of task (Regular or Compact) */
  kind: TaskKind;

  /** AbortController for cancelling task execution */
  abortController: AbortController;

  /** Promise representing the running task (returns final assistant message or null) */
  promise: Promise<string | null>;

  /** Timestamp when task was spawned (for debugging/monitoring) */
  startTime: number;
}

/**
 * Callback to resolve a pending approval
 */
export type ApprovalResolver = (decision: ReviewDecision) => void;

/**
 * Pending approval entry
 */
export interface PendingApproval {
  /** Unique identifier for this approval request */
  executionId: string;
  /** Resolver callback */
  resolver: ApprovalResolver;
}

/**
 * Token usage information
 * Matches existing Session token tracking
 */
export interface TokenUsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Rate limit snapshot
 * Matches existing Session rate limit tracking
 */
export interface RateLimitSnapshot {
  limit_requests?: number;
  limit_tokens?: number;
  remaining_requests?: number;
  remaining_tokens?: number;
  reset_requests?: string;
  reset_tokens?: string;
}

/**
 * Session export format
 * Matches existing Session.export() structure
 */
export interface SessionExport {
  id: string;
  state: {
    history: any; // ConversationHistory from protocol
    approvedCommands: string[];
    tokenInfo?: TokenUsageInfo;
    latestRateLimits?: RateLimitSnapshot;
  };
  metadata: {
    created: number;
    lastAccessed: number;
    messageCount: number;
  };
}

/**
 * Reason for aborting a turn
 */
export type TurnAbortReason = 'Replaced' | 'UserInterrupt' | 'Error' | 'Timeout';

/**
 * Configuration for initializing a new Session
 * Browser-compatible subset (excludes shell discovery)
 */
export interface ConfigureSession {
  /** Conversation ID for this session */
  conversationId: string;

  /** Initial instructions for the agent */
  instructions?: string;

  /** Working directory for command execution (browser: simulated) */
  cwd?: string;

  /** Default model to use */
  model?: string;

  /** Approval policy for commands */
  approvalPolicy?: any; // AskForApproval from protocol

  /** Sandbox policy for tool execution */
  sandboxPolicy?: any; // SandboxPolicy from protocol

  /** Optional reasoning configuration */
  reasoningEffort?: any; // ReasoningEffortConfig from protocol
  reasoningSummary?: any; // ReasoningSummaryConfig from protocol
}

/**
 * Initial history mode for session creation
 */
export type InitialHistory =
  | { mode: 'new' }
  | { mode: 'resumed'; rolloutItems: any[] } // RolloutItem[] from rollout
  | { mode: 'forked'; rolloutItems: any[]; sourceConversationId: string };

/**
 * Type guards for InitialHistory modes
 */
export function isNewHistory(history: InitialHistory): history is { mode: 'new' } {
  return history.mode === 'new';
}

export function isResumedHistory(history: InitialHistory): history is { mode: 'resumed'; rolloutItems: any[] } {
  return history.mode === 'resumed';
}

export function isForkedHistory(history: InitialHistory): history is { mode: 'forked'; rolloutItems: any[]; sourceConversationId: string } {
  return history.mode === 'forked';
}
