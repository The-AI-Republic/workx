// File: src/core/engine/RepublicAgentEngineConfig.ts

import type { AgentConfig } from '../../config/AgentConfig';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { IEventRouter } from '../events/IEventRouter';
import type { ApprovalGate } from '../approval/ApprovalGate';
import type { ModelClientFactory } from '../models/ModelClientFactory';
import type { Session } from '../Session';
import type { ApprovalManager } from '../ApprovalManager';
import type { AskForApproval, ReviewDecision } from '../protocol/types';
import type { IBrowserController } from '../platform/IPlatformAdapter';
import type { InitialHistory } from '../session/state/types';

export interface RepublicAgentEngineConfig {
  /** AgentConfig instance (shared — for credentials and provider info) */
  agentConfig: AgentConfig;

  /** Pre-built ToolRegistry (caller controls which tools are available) */
  toolRegistry: ToolRegistry;

  /** System prompt (base instructions) for this engine */
  systemPrompt: string;

  /** Optional user instructions appended to system prompt */
  userInstructions?: string;

  /** Model to use. If omitted, uses agentConfig.selectedModelKey */
  model?: string;

  /** Shared ModelClientFactory (reuses parent's cached clients + auth) */
  modelClientFactory: ModelClientFactory;

  /** Max turns before forced stop. Default: 500 (TaskRunner.MAX_TURNS) */
  maxTurns?: number;

  /** Approval policy applied to the engine's TurnContext */
  approvalPolicy?: AskForApproval;

  /** Whether to persist session history. Default: false for sub-agents */
  persistent?: boolean;

  /**
   * Optional ApprovalGate for tool execution approval.
   * ApprovalGate internally contains ApprovalManager for user interactions.
   * If not provided, all tool calls auto-approve (no stopping).
   * RepublicAgent injects its ApprovalGate; sub-agents typically omit this.
   */
  approvalGate?: ApprovalGate;

  /**
   * Optional ApprovalManager for risk-based approval routing.
   * Required for dual-path approval resolution (ApprovalManager + Session).
   * If not provided, approvals only route through Session.notifyApproval().
   */
  approvalManager?: ApprovalManager;

  /**
   * Externally-managed Session instance.
   * If provided, the engine uses this session for task execution.
   * If omitted, the engine creates its own Session during initialize().
   */
  session?: Session;

  /**
   * Whether this engine manages the session lifecycle (dispose on engine dispose).
   * true when session is internally created (sub-agents).
   * false when session is externally provided (main agent).
   * Default: true if session is not provided, false if session is provided.
   */
  ownsSession?: boolean;

  /**
   * Optional browser context for sub-agents that need browser tools.
   * If provided, sub-agent can use browser tools with this context.
   */
  browserContext?: {
    tabId: number;
    controller: IBrowserController;
  };

  /**
   * Optional event router for namespacing sub-agent events.
   * If provided, events are routed through this instead of direct emission.
   */
  eventRouter?: IEventRouter;

  /**
   * Parent engine ID for tracing nested sub-agents.
   */
  parentEngineId?: string;

  /**
   * Current nesting depth of this engine in the sub-agent hierarchy.
   * 0 = top-level agent. Incremented by createChildEngine().
   */
  depth?: number;

  /**
   * Maximum allowed sub-agent nesting depth. Default: 3.
   */
  maxDepth?: number;

  /**
   * Callback that drains cross-agent messages injected between turns.
   * Called by TaskRunner before building each turn's input.
   */
  drainPendingMessages?: () => string[];

  /**
   * (Track 04) Shared TaskOutputStore for chunked output emission.
   * Background sub-agent task runners write chunks here at turn
   * boundaries; foreground RegularTasks leave this undefined and skip
   * persistence. See design.md §TaskOutputStore.
   */
  taskOutputStore?: import('../tasks/TaskOutputStore').TaskOutputStore;

  /**
   * Initial conversation history (for session recovery).
   */
  initialHistory?: InitialHistory;
}

export interface EngineResult {
  /** Whether execution completed successfully */
  success: boolean;

  /** Final assistant text response (last AgentMessage) */
  response: string | null;

  /** Number of turns executed */
  turnCount: number;

  /** Token usage for this execution */
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };

  /** Why execution stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';

  /** Error message if stopReason is 'error' */
  error?: string;

  /** Engine ID for tracing */
  engineId: string;

  /** Submission ID that produced this result */
  submissionId: string;
}

export interface RunOptions {
  /** Override max turns for this specific run */
  maxTurns?: number;

  /** AbortSignal for external cancellation */
  signal?: AbortSignal;

  /** Context for the execution (tabId, etc.) */
  context?: ExecutionContext;

  /** Timeout in milliseconds for awaitable mode. Default: 600000 (10 minutes) */
  timeoutMs?: number;

  /** Progress callback invoked after each turn completes */
  onProgress?: (info: { type: 'turn_complete'; turnNumber: number }) => void;
}

export interface ExecutionContext {
  tabId?: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/** Operations handled by RepublicAgentEngine */
export type EngineOp =
  | { type: 'UserInput'; items: InputItem[]; context?: ExecutionContext; contextOverrides?: Record<string, unknown> }
  | { type: 'UserTurn'; items: InputItem[]; context?: ExecutionContext; contextOverrides?: Record<string, unknown> }
  | { type: 'Interrupt'; reason?: string }
  | { type: 'ExecApproval'; callId: string; decision: ReviewDecision; remember?: boolean; alternativeText?: string }
  | { type: 'PatchApproval'; patchId: string; decision: ReviewDecision }
  | { type: 'Compact'; mode?: 'auto' | 'manual' }
  | { type: 'ManualCompact' }
  | { type: 'AddToHistory'; text: string }
  | { type: 'Shutdown' }
  | { type: 'ClearHistory' };

/** Operations that stay in RepublicAgent (orchestration-specific) */
export type OrchestrationOp =
  | { type: 'GetPath' }
  | { type: 'GetHistoryEntry'; entryId: string }
  | { type: 'ConfigChange'; key: string; value: unknown }
  | { type: 'ModelSwitch'; modelKey: string }
  | { type: 'TabSwitch'; tabId: number };

export interface Submission {
  id: string;
  op: EngineOp;
  timestamp: number;
}

/**
 * Represents an input item for the engine.
 * Can be text or structured content.
 */
export interface InputItem {
  type: 'text' | 'image' | 'file';
  text?: string;
  data?: string;
  mimeType?: string;
  path?: string;
}

/**
 * Represents an event emitted by the engine.
 */
export interface EngineEvent {
  id: string;
  msg: {
    type: string;
    data?: Record<string, unknown>;
    _subAgent?: {
      engineId: string;
      parentEngineId?: string;
      depth: number;
    };
  };
}

// Re-export IBrowserController from the canonical definition
export type { IBrowserController };

/**
 * Conversation history entry for session recovery.
 */
export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
  timestamp?: number;
}
