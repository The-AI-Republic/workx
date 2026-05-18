import type { AskForApproval, ResponseItem } from '@/core/protocol/types';
import type { InitialHistory } from '@/core/session/state/types';
import type { PreExecuteCheck } from '@/tools/ToolRegistry';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';

export enum ShadowAgentKind {
  SessionSummary = 'session_summary',
  Compact = 'compact',
  PromptSuggestion = 'prompt_suggestion',
  MemoryExtraction = 'memory_extraction',
  Diagnostics = 'diagnostics',
}

export enum ShadowAgentPriority {
  Immediate = 'immediate',
  Normal = 'normal',
  Idle = 'idle',
}

export enum ShadowContextPolicy {
  None = 'none',
  PromptOnly = 'prompt_only',
  ParentHistory = 'parent_history',
  ParentHistoryWithSummary = 'parent_history_with_summary',
  CompactCandidate = 'compact_candidate',
}

export enum ShadowFailurePolicy {
  Throw = 'throw',
  ReturnError = 'return_error',
  LogAndSuppress = 'log_and_suppress',
  Fallback = 'fallback',
}

export type ShadowAgentStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'fallback_used';

export type ShadowQueuePolicy =
  | 'queue'
  | 'coalesce_latest'
  | 'abort_previous'
  | 'drop_duplicate';

export interface ShadowToolPolicy {
  allow?: string[];
  deny?: string[];
  preExecuteCheck?: PreExecuteCheck;
  exact?: boolean;
}

export interface ShadowAgentProfile {
  kind: ShadowAgentKind;
  defaultContextPolicy: ShadowContextPolicy;
  defaultPriority: ShadowAgentPriority;
  failurePolicy: ShadowFailurePolicy;
  maxConcurrency: number;
  queuePolicy: ShadowQueuePolicy;
  timeoutMs: number;
  maxTurns: number;
  toolPolicy: ShadowToolPolicy;
  approvalPolicy?: AskForApproval;
  visibleToUser: boolean;
  suppressedEvents?: readonly string[];
}

export interface ShadowContextInput {
  parentHistory?: ResponseItem[];
  sessionSummary?: string;
  compactCandidateHistory?: ResponseItem[];
}

export interface ShadowAgentRequest {
  kind: ShadowAgentKind;
  prompt: string;
  systemPrompt?: string;
  parentEngine?: RepublicAgentEngine;
  contextPolicy?: ShadowContextPolicy;
  context?: ShadowContextInput;
  toolPolicy?: ShadowToolPolicy;
  model?: string;
  maxTurns?: number;
  priority?: ShadowAgentPriority;
  queuePolicy?: ShadowQueuePolicy;
  failurePolicy?: ShadowFailurePolicy;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  fallback?: (error: unknown) => Promise<string | undefined> | string | undefined;
}

export interface ShadowAgentResolvedRequest extends Omit<ShadowAgentRequest, 'parentEngine'> {
  parentEngine: RepublicAgentEngine;
  systemPrompt: string;
  contextPolicy: ShadowContextPolicy;
  toolPolicy: ShadowToolPolicy;
  maxTurns: number;
  priority: ShadowAgentPriority;
  queuePolicy: ShadowQueuePolicy;
  failurePolicy: ShadowFailurePolicy;
  timeoutMs: number;
  profile: ShadowAgentProfile;
  runId: string;
}

export interface ShadowAgentResult {
  kind: ShadowAgentKind;
  status: ShadowAgentStatus;
  outputText?: string;
  error?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  durationMs: number;
  runId: string;
  childEngineId?: string;
  fallbackOutputText?: string;
}

export interface ShadowAgentDiagnostics {
  active: Array<ShadowJobSnapshot>;
  queued: Array<ShadowJobSnapshot>;
  recent: ShadowAgentResult[];
  lastFailureByKind: Partial<Record<ShadowAgentKind, ShadowAgentResult>>;
  timeoutCount: number;
  fallbackCount: number;
}

export interface ShadowJobSnapshot {
  runId: string;
  kind: ShadowAgentKind;
  priority: ShadowAgentPriority;
  dedupeKey?: string;
  startedAt?: number;
  queuedAt: number;
  timeoutMs: number;
}

export interface ShadowInitialHistoryResult {
  initialHistory?: InitialHistory;
  parentItemCount: number;
}
