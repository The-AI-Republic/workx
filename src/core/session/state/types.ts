/**
 * Shared types for state management
 */

import type { ReviewDecision } from '../../protocol/types';
import type { SessionTask } from '../../tasks/SessionTask';
import type { BackgroundAgentTaskState } from '../../tasks/types';
import type { AgentContext } from '../../../tools/AgentTool/types';

/**
 * Track 12: the real rate-limit snapshot shape is the percent-window model
 * produced by every provider's `parseRateLimitSnapshot()` and carried in the
 * `RateLimits` ResponseEvent. The previous local `{ limit_requests, ... }`
 * interface here was an orphan (never populated or read), which is why
 * `Session.sendTokenCountEvent` could only ever emit `undefined`. Re-export
 * the canonical type so SessionState stores what providers actually emit.
 */
import type { RateLimitSnapshot } from '../../models/types/RateLimits';
export type { RateLimitSnapshot };

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

  /** Reference to the session task for cleanup */
  task: SessionTask;

  /** Promise representing the running task (returns final assistant message or null) */
  promise: Promise<string | null>;

  /** Timestamp when task was spawned (for debugging/monitoring) */
  startTime: number;

  // ─── Track 04 typed-task extensions ─────────────────────────────────
  // These fields are populated only for tasks tracked in Session.activeTasks
  // with the typed-state layer (currently: background_agent sub-agents).
  // Foreground RegularTask spawns may leave them undefined.

  /**
   * Typed state record that the UI, parent agent, and event consumers
   * read. Populated by SubAgentRunner.prepare via Session.registerTaskState.
   */
  taskState?: BackgroundAgentTaskState;

  /**
   * AgentContext from the sub-agent runner. Used by handleTaskAbort to
   * set `context.cancelled = true` BEFORE the AbortController fires, which
   * suppresses the misleading task-notification the detached IIFE in
   * SubAgentRunner would otherwise emit (Q7).
   */
  context?: AgentContext;

  /**
   * Tab IDs this task actively uses. On chrome.tabs.onRemoved for a
   * working tab, Session.abortTasksForTab walks activeTasks and aborts
   * only those whose scopedTabIds includes the closing tab (Q9).
   *
   * ⚠️  Known limitation (Track 04 v1): set at spawn time from
   * browserContext.tabId and NOT updated when a sub-agent's tools
   * navigate it to a different tab mid-run. Two consequences:
   *
   *   - Closing the *new* tab won't abort the sub-agent that's actually
   *     using it.
   *   - Closing the *original* tab will abort a sub-agent that no longer
   *     touches it.
   *
   * For v1 this is acceptable because sub-agents typically stay on the
   * tab they started on. If sub-agents start switching tabs routinely,
   * wire the tab-change tool path to call a yet-to-exist
   * Session.updateScopedTabs(taskId, tabIds) method.
   */
  scopedTabIds?: number[];
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
export type TurnAbortReason = 'Replaced' | 'UserInterrupt' | 'Error' | 'Timeout' | 'TabClosed';

/**
 * Configuration for initializing a new Session
 * Browser-compatible subset (excludes shell discovery)
 */
export interface ConfigureSession {
  /** Conversation ID for this session */
  sessionId: string;

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
  | { mode: 'resumed'; sessionId: string; rolloutItems: any[] } // RolloutItem[] from rollout
  | { mode: 'forked'; rolloutItems: any[]; sourceConversationId: string };

/**
 * Type guards for InitialHistory modes
 */
export function isNewHistory(history: InitialHistory): history is { mode: 'new' } {
  return history.mode === 'new';
}

export function isResumedHistory(history: InitialHistory): history is { mode: 'resumed'; sessionId: string; rolloutItems: any[] } {
  return history.mode === 'resumed';
}

export function isForkedHistory(history: InitialHistory): history is { mode: 'forked'; rolloutItems: any[]; sourceConversationId: string } {
  return history.mode === 'forked';
}
