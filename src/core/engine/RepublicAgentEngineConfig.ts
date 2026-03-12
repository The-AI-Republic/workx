// File: src/core/engine/RepublicAgentEngineConfig.ts

import type { AgentConfig } from '../../config/AgentConfig';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { IEventRouter } from '../events/IEventRouter';
import type { ApprovalGate } from '../approval/ApprovalGate';

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
   * Initial conversation history (for session recovery).
   */
  initialHistory?: ConversationEntry[];
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
}

export interface ExecutionContext {
  tabId?: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/** Operations handled by RepublicAgentEngine */
export type EngineOp =
  | { type: 'UserInput'; items: InputItem[]; context?: ExecutionContext }
  | { type: 'UserTurn'; items: InputItem[]; context?: ExecutionContext }
  | { type: 'Interrupt'; reason?: string }
  | { type: 'ExecApproval'; callId: string; approved: boolean; remember?: boolean }
  | { type: 'PatchApproval'; patchId: string; approved: boolean }
  | { type: 'Compact'; mode?: 'auto' | 'manual' }
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

/**
 * Interface for browser controller.
 * Actual implementations vary by platform.
 */
export interface IBrowserController {
  navigate(url: string): Promise<void>;
  getPageContent(): Promise<string>;
  screenshot(): Promise<string>;
  executeScript(script: string): Promise<unknown>;
}

/**
 * Interface for model client factory.
 */
export interface ModelClientFactory {
  createClient(modelKey: string): Promise<ModelClient>;
  createClientForCurrentModel(): Promise<ModelClient>;
  initialize(config: AgentConfig): Promise<void>;
}

/**
 * Interface for model client.
 */
export interface ModelClient {
  chat(messages: unknown[], options?: unknown): Promise<unknown>;
}

/**
 * Conversation history entry for session recovery.
 */
export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
  timestamp?: number;
}
