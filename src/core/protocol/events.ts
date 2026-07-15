/**
 * Event types
 */

import type { PlanReviewPlan } from '../../tools/planReview/types';
import type {
  ReviewRequest,
  ResponseItem,
  AskForApproval,
  SandboxPolicy,
  ReasoningEffortConfig,
  ReasoningSummaryConfig,
} from './types';
import type { TaskSummary } from '../taskmanager/types';
import type { AgentMode } from '../../prompts/PromptComposer';

/**
 * Event Queue Entry - responses from agent
 */
export interface Event {
  /** Unique id for this Event */
  id: string;
  /** Event message */
  msg: EventMsg;
}

/**
 * Complete EventMsg enumeration
 */
export type EventMsg =
  | { type: 'Error'; data: ErrorEvent }
  | { type: 'TaskStarted'; data: TaskStartedEvent }
  | { type: 'TaskComplete'; data: TaskCompleteEvent }
  | { type: 'TokenCount'; data: TokenCountEvent }
  | { type: 'AgentMessage'; data: AgentMessageEvent }
  | { type: 'UserMessage'; data: UserMessageEvent }
  | { type: 'AgentMessageDelta'; data: AgentMessageDeltaEvent }
  | { type: 'AgentReasoning'; data: AgentReasoningEvent }
  | { type: 'AgentReasoningDelta'; data: AgentReasoningDeltaEvent }
  | { type: 'AgentReasoningRawContent'; data: AgentReasoningRawContentEvent }
  | { type: 'AgentReasoningRawContentDelta'; data: AgentReasoningRawContentDeltaEvent }
  | { type: 'AgentReasoningSectionBreak'; data: AgentReasoningSectionBreakEvent }
  | { type: 'SessionConfigured'; data: SessionConfiguredEvent }
  | { type: 'McpToolCallBegin'; data: McpToolCallBeginEvent }
  | { type: 'McpToolCallEnd'; data: McpToolCallEndEvent }
  | { type: 'WebSearchBegin'; data: WebSearchBeginEvent }
  | { type: 'WebSearchEnd'; data: WebSearchEndEvent }
  | { type: 'ExecCommandBegin'; data: ExecCommandBeginEvent }
  | { type: 'ExecCommandOutputDelta'; data: ExecCommandOutputDeltaEvent }
  | { type: 'ExecCommandEnd'; data: ExecCommandEndEvent }
  | { type: 'ExecApprovalRequest'; data: ExecApprovalRequestEvent }
  | { type: 'ApplyPatchApprovalRequest'; data: ApplyPatchApprovalRequestEvent }
  | { type: 'BackgroundEvent'; data: BackgroundEventEvent }
  | { type: 'StreamError'; data: StreamErrorEvent }
  | { type: 'PatchApplyBegin'; data: PatchApplyBeginEvent }
  | { type: 'PatchApplyEnd'; data: PatchApplyEndEvent }
  | { type: 'TurnDiff'; data: TurnDiffEvent }
  | { type: 'GetHistoryEntryResponse'; data: GetHistoryEntryResponseEvent }
  | { type: 'McpListToolsResponse'; data: McpListToolsResponseEvent }
  | { type: 'ListCustomPromptsResponse'; data: ListCustomPromptsResponseEvent }
  | { type: 'PlanUpdate'; data: PlanToolArgs }
  | { type: 'TaskUpdate'; data: TaskUpdateEvent }
  | { type: 'TurnAborted'; data: TurnAbortedEvent }
  | { type: 'ShutdownComplete' }
  | { type: 'ConversationPath'; data: ConversationPathResponseEvent }
  | { type: 'EnteredReviewMode'; data: ReviewRequest }
  | { type: 'ExitedReviewMode'; data: ExitedReviewModeEvent }
  | { type: 'Notification'; data: NotificationEvent }
  | { type: 'Interrupted' }
  | { type: 'TaskFailed'; data: TaskFailedEvent }
  | { type: 'CompactionCompleted'; data: CompactionCompletedEvent }
  | { type: 'ApprovalAutoApproved'; data: ApprovalAutoApprovedEvent }
  | { type: 'ApprovalRequested'; data: ApprovalRequestedEvent }
  | { type: 'ApprovalGranted'; data: ApprovalGrantedEvent }
  | { type: 'ApprovalDenied'; data: ApprovalDeniedEvent }
  | { type: 'ApprovalPolicyChanged'; data: ApprovalPolicyChangedEvent }
  // DiffTracker events
  | { type: 'ChangeAdded'; data: ChangeAddedEvent }
  | { type: 'ChangesRetrieved'; data: ChangesRetrievedEvent }
  | { type: 'RollbackStarted'; data: RollbackStartedEvent }
  | { type: 'BatchRollbackStarted'; data: BatchRollbackStartedEvent }
  | { type: 'SessionRollbackStarted'; data: SessionRollbackStartedEvent }
  | { type: 'RollbackCompleted'; data: RollbackCompletedEvent }
  | { type: 'SnapshotCreated'; data: SnapshotCreatedEvent }
  | { type: 'SnapshotRestored'; data: SnapshotRestoredEvent }
  | { type: 'ChangesCleared'; data: ChangesClearedEvent }
  // Tool registry events
  | { type: 'ToolRegistered'; data: ToolRegisteredEvent }
  | { type: 'ToolUnregistered'; data: ToolUnregisteredEvent }
  | { type: 'ToolExposureUpdated'; data: ToolExposureUpdatedEvent }
  | { type: 'ToolExecutionStart'; data: ToolExecutionStartEvent }
  | { type: 'ToolExecutionEnd'; data: ToolExecutionEndEvent }
  | { type: 'ToolExecutionError'; data: ToolExecutionErrorEvent }
  | { type: 'ToolExecutionTimeout'; data: ToolExecutionTimeoutEvent }
  | { type: 'ToolExecutionProgress'; data: ToolExecutionProgressEvent }
  // Reasoning stream events
  | { type: 'ReasoningSummaryDelta'; data: ReasoningSummaryDeltaEvent }
  | { type: 'ReasoningContentDelta'; data: ReasoningContentDeltaEvent }
  | { type: 'ReasoningSummaryPartAdded'; data: ReasoningSummaryPartAddedEvent }
  // Turn lifecycle events
  | { type: 'TurnStarted'; data: TurnStartedEvent }
  | { type: 'TurnComplete'; data: TurnCompleteEvent }
  | { type: 'PromptSuggestion'; data: PromptSuggestionEvent }
  | { type: 'ContextUpdated'; data: ContextUpdatedEvent }
  | { type: 'TurnRetry'; data: TurnRetryEvent }
  // Track 12: rate-limit resilience events
  | { type: 'RateLimitWaiting'; data: RateLimitWaitingEvent }
  | { type: 'RateLimitWarning'; data: RateLimitWarningEvent }
  | { type: 'ModelDowngraded'; data: ModelDowngradedEvent }
  // Browser action events
  | { type: 'DOMActionStart'; data: DOMActionStartEvent }
  | { type: 'StorageActionStart'; data: StorageActionStartEvent }
  | { type: 'NavigationActionStart'; data: NavigationActionStartEvent }
  // Service routing events
  | { type: 'ServiceResponse'; data: ServiceResponseEvent }
  | { type: 'StateUpdate'; data: StateUpdateEvent }
  // Per-session agent persona mode
  | { type: 'ModeChanged'; data: ModeChangedEvent }
  // Hook system events
  | { type: 'HookFired'; data: HookFiredEvent }
  | { type: 'HookBlocked'; data: HookBlockedEvent }
  | { type: 'HookResult'; data: HookResultEvent }
  // Sub-agent lifecycle events
  | { type: 'SubAgentStart'; data: SubAgentStartEvent }
  | { type: 'SubAgentComplete'; data: SubAgentCompleteEvent }
  | { type: 'SubAgentError'; data: SubAgentErrorEvent }
  | { type: 'SubAgentWarning'; data: SubAgentWarningEvent }
  // Shadow-agent runtime events (internal observability; UI ignores by default)
  | { type: 'ShadowAgentStarted'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentCompleted'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentFailed'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentCancelled'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentCoalesced'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentTimedOut'; data: ShadowAgentRuntimeEventData }
  | { type: 'ShadowAgentFallbackUsed'; data: ShadowAgentRuntimeEventData }
  // Session summary telemetry (internal observability; UI ignores by default)
  | { type: 'SessionSummaryTelemetry'; data: SessionSummaryTelemetryEventData }
  // Track 04: typed-task layer events (background sub-agents only in v1)
  | { type: 'BackgroundTaskStarted'; data: BackgroundTaskStartedEvent }
  | { type: 'BackgroundTaskOutputDelta'; data: BackgroundTaskOutputDeltaEvent }
  | { type: 'BackgroundTaskStateChanged'; data: BackgroundTaskStateChangedEvent }
  | { type: 'BackgroundTaskTerminated'; data: BackgroundTaskTerminatedEvent }
;

// ─── Track 04 event payloads ──────────────────────────────────────────────

export interface BackgroundTaskStartedEvent {
  taskId: string;
  type: 'background_agent';
  description: string;
  startTime: number;
}

/**
 * Metadata-only delta event. Chunks themselves stay in TaskOutputStore;
 * subscribers poll engine.getTaskOutput(taskId, fromSeq) when interested.
 */
export interface BackgroundTaskOutputDeltaEvent {
  taskId: string;
  fromSeq: number;
  toSeq: number;
  /** Per-kind chunk counts in this delta range (for UI badges). */
  kindCounts: Partial<Record<'stdout' | 'stderr' | 'event' | 'message', number>>;
}

export interface BackgroundTaskStateChangedEvent {
  taskId: string;
  prevStatus: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  /** Failure reason when status === 'failed' (e.g. a gateway/model error). */
  error?: string;
}

export interface BackgroundTaskTerminatedEvent {
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  endTime: number;
  durationMs: number;
  summary?: string;
  /** Failure reason when status === 'failed' (e.g. a gateway/model error). */
  error?: string;
}

// Individual event payload types

/**
 * Internal telemetry for the session-summary feature (Track 05b).
 *
 * Emitted by the SessionSummaryHook and the compaction interlock. UI consumers
 * ignore this event type; only the (future) observability sink reads it.
 * Mirrors claudy's dedicated services/analytics channel — separate from
 * user-facing events.
 */
export type SessionSummaryTelemetryName =
  | 'init'
  | 'file_read'
  | 'extraction'
  | 'manual_extraction'
  | 'loaded'
  | 'compact_skipped_empty_summary'
  | 'compact_with_summary'
  | 'compact_extraction_wait_timeout';

export interface SessionSummaryTelemetryEventData {
  /** Discriminator within the SessionSummaryTelemetry envelope. */
  event: SessionSummaryTelemetryName;
  /** Owning session. Not duplicated into payload. */
  sessionId: string;
  /** Event-specific fields. Shape depends on `event`; see design §11. */
  payload: Record<string, unknown>;
  /** Index signature so this is assignable to `EngineEvent.msg.data`. */
  [key: string]: unknown;
}

/**
 * Convenience alias so call sites can construct a fully-formed envelope.
 * Equivalent to `Extract<EventMsg, { type: 'SessionSummaryTelemetry' }>`.
 */
export interface SessionSummaryTelemetryEvent {
  type: 'SessionSummaryTelemetry';
  data: SessionSummaryTelemetryEventData;
}

export interface ShadowAgentRuntimeEventData {
  run_id: string;
  kind: string;
  priority: string;
  status?: string;
  duration_ms?: number;
  timeout_ms?: number;
  failure_policy: string;
  model?: string;
  parent_engine_id?: string;
  child_engine_id?: string;
  dedupe_key?: string;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ErrorEvent {
  message: string;
  code?: string;
}

/**
 * Emitted when a session's agent persona mode changes (or is requested but
 * deferred because a task is in flight). The UI is the consumer — it commits
 * the tab's mode on `applied: true` and shows a pending state otherwise.
 */
export interface ModeChangedEvent {
  sessionId: string;
  mode: AgentMode;
  /** true = applied to the live turn context now; false = deferred */
  applied: boolean;
}

export interface TaskStartedEvent {
  submission_id?: string;
  model_context_window?: number;
  model?: string;
  tabId?: number; // Replaced cwd with tabId
  approval_policy?: AskForApproval;
  sandbox_policy?: SandboxPolicy;
  review_mode?: boolean;
  auto_compact?: boolean;
  compaction_threshold?: number;
  tools?: string[];
  tools_config?: Record<string, unknown>;
  timeout_ms?: number;
  browser_environment_policy?: string;
  reasoning_effort?: ReasoningEffortConfig;
  reasoning_summary?: ReasoningSummaryConfig;
  turn_type?: string;
}

export interface TaskTokenUsageSummary {
  total?: TokenUsage;
  last_turn?: TokenUsage;
}

export interface TaskCompleteEvent {
  submission_id?: string;
  last_agent_message?: string;
  turn_count?: number;
  token_usage?: TaskTokenUsageSummary;
  /** Track 18: USD cost for this task, computed once in core. */
  cost_usd?: number;
  /** Track 18: true if any turn was priced via the fallback rate. */
  cost_estimated?: boolean;
  compaction_performed?: boolean;
  aborted?: boolean;
  abort_reason?: TurnAbortReason;
  turn_id?: string;
  input_messages?: string[];
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface TokenUsageInfo {
  total_token_usage: TokenUsage;
  last_token_usage: TokenUsage;
  model_context_window?: number;
  auto_compact_token_limit?: number;
}

export interface TokenCountEvent {
  info?: TokenUsageInfo;
  token_warning_state?: {
    current_tokens: number;
    context_window?: number;
    auto_compact_token_limit?: number;
    percent_used?: number;
    percent_left?: number;
    is_above_warning_threshold: boolean;
    is_above_error_threshold: boolean;
    is_above_auto_compact_threshold: boolean;
    is_at_blocking_limit: boolean;
  };
  rate_limits?: RateLimitSnapshotEvent;
  /** Track 18: cumulative session USD cost (additive rider on Track 12's fix). */
  cost?: number;
  /** Track 18: true if any of the cumulative cost was estimated. */
  cost_estimated?: boolean;
}

export interface RateLimitSnapshotEvent {
  /** Percentage (0-100) of the primary window that has been consumed */
  primary_used_percent: number;
  /** Percentage (0-100) of the secondary window that has been consumed */
  secondary_used_percent: number;
  /** Size of the primary window relative to secondary (0-100) */
  primary_to_secondary_ratio_percent: number;
  /** Rolling window duration for the primary limit, in minutes */
  primary_window_minutes: number;
  /** Rolling window duration for the secondary limit, in minutes */
  secondary_window_minutes: number;
}

export interface AgentMessageEvent {
  message: string;
}

export interface UserMessageEvent {
  message: string;
  kind?: 'plain' | 'user_instructions' | 'environment_context' | null;
  images?: string[];
}

export interface AgentMessageDeltaEvent {
  delta: string;
}

export interface AgentReasoningEvent {
  content: string;
  reasoning?: string;
}

export interface AgentReasoningDeltaEvent {
  delta: string;
}

export interface AgentReasoningRawContentEvent {
  content: string;
}

export interface AgentReasoningRawContentDeltaEvent {
  delta: string;
}

export interface AgentReasoningSectionBreakEvent {
  title?: string;
}

export interface SessionConfiguredEvent {
  session_id: string;
}

export interface McpToolCallBeginEvent {
  tool_name: string;
  params: any;
  call_id?: string;
}

export interface McpToolCallEndEvent {
  tool_name: string;
  result?: any;
  error?: string;
  call_id?: string;
  duration_ms?: number;
}

export interface WebSearchBeginEvent {
  query?: string;
  call_id?: string;
}

export interface WebSearchEndEvent {
  call_id?: string;
  query?: string;
  result?: any;
  error?: string;
  results_count?: number;
}

export interface ExecCommandBeginEvent {
  session_id: string;
  command: string;
  /** Added for Chrome extension context */
  tab_id?: number;
  url?: string;
}

export interface ExecCommandOutputDeltaEvent {
  session_id: string;
  output: string;
  stream: 'stdout' | 'stderr';
}

export interface ExecCommandEndEvent {
  session_id: string;
  exit_code: number;
  duration_ms?: number;
}

export interface ExecApprovalRequestEvent {
  id: string;
  command: string;
  explanation?: string;
}

export interface ApplyPatchApprovalRequestEvent {
  id: string;
  path: string;
  patch: string;
  num_files?: number;
  explanation?: string;
}

export interface BackgroundEventEvent {
  message: string;
  level?: 'info' | 'warning' | 'error';
  schedulerEvent?: unknown;
  sessionEvent?: unknown;
}

export interface StreamErrorEvent {
  error: string;
  retrying: boolean;
  attempt?: number;
  /**
   * Delay before the next retry attempt, when applicable.
   */
  delayMs?: number;
  /**
   * Maximum number of retry attempts configured for the turn.
   */
  maxRetries?: number;
}

export interface PatchApplyBeginEvent {
  path: string;
  description?: string;
  session_id?: string;
  num_files?: number;
}

export interface PatchApplyEndEvent {
  path: string;
  success: boolean;
  error?: string;
  session_id?: string;
}

export interface TurnDiffEvent {
  diff: string;
  files_changed: number;
}

export interface GetHistoryEntryResponseEvent {
  entry?: ResponseItem;
  error?: string;
}

export interface McpListToolsResponseEvent {
  tools: McpTool[];
}

export interface McpTool {
  name: string;
  description: string;
  parameters?: any;
}

export interface ListCustomPromptsResponseEvent {
  prompts: CustomPrompt[];
}

export interface CustomPrompt {
  name: string;
  content: string;
}

/**
 * Step status for plan items
 */
export enum StepStatus {
  Pending = "Pending",
  InProgress = "InProgress",
  Completed = "Completed",
}

/**
 * A single step in the task plan
 */
export interface PlanStepArg {
  /** Step description (5-10 words) */
  step: string;
  /** Current execution state */
  status: StepStatus;
}

/**
 * Input arguments for the PlanningTool — full-state overwrite every call
 * @deprecated Use TaskUpdateEvent instead. Kept for backward compatibility.
 */
export interface PlanToolArgs {
  /** What changed in this update */
  explanation?: string;
  /** Full ordered list of plan steps (required) */
  plan: PlanStepArg[];
}

/**
 * Event payload for persistent task management updates
 */
export interface TaskUpdateEvent {
  eventType: 'plan_created' | 'updated' | 'completed' | 'deleted';
  task?: {
    id: string;
    subject: string;
    activeForm?: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
  };
  allTasks: TaskSummary[];
}

export interface TurnAbortedEvent {
  reason: TurnAbortReason;
  submission_id?: string;
  turn_count?: number;
  message?: string;
}

export type TurnAbortReason = 'user_interrupt' | 'automatic_abort' | 'error' | 'user_request';

export interface ConversationPathResponseEvent {
  path: string;
  messages_count: number;
}

export interface ExitedReviewModeEvent {
  review_output?: ReviewOutputEvent;
}

export interface ReviewOutputEvent {
  approved: boolean;
  changes?: string;
  comments?: string;
}

export interface NotificationEvent {
  id: string;
  type: string;
  title: string;
  message: string;
  timestamp: number;
}

export interface TaskFailedEvent {
  /** Submission this failure terminates (lets the engine match the awaiter). */
  submission_id?: string;
  reason: string;
  error?: string;
  message?: string;
}

/**
 * Event emitted when chat history compaction completes
 */
export interface CompactionCompletedEvent {
  /** Whether compaction succeeded */
  success: boolean;
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** Number of history items trimmed */
  itemsTrimmed: number;
  /** Total number of compactions in this session */
  compactionCount: number;
  /** What triggered this compaction */
  triggerReason: 'auto' | 'manual';
  /** Error message if compaction failed */
  error?: string;
}

/**
 * Event emitted when a tool call is auto-approved by the approval system
 */
export interface ApprovalAutoApprovedEvent {
  tool_name: string;
  risk_score: number;
  risk_level: string;
}

/**
 * Event emitted when user approval is requested for a tool call
 */
export interface ApprovalRequestedEvent {
  id: string;
  tool_name: string;
  risk_score: number;
  risk_level: string;
  risk_factors: string[];
  explanation: string;
  command?: string;
  timeout?: number;
  /** Track 14: structured plan for the editable Plan Review card. */
  plan?: PlanReviewPlan;
}

/**
 * Event emitted when a tool call is granted by the user
 */
export interface ApprovalGrantedEvent {
  id: string;
  tool_name: string;
  timestamp: number;
  reason?: string;
}

/**
 * Event emitted when a tool call is denied by the user or system
 */
export interface ApprovalDeniedEvent {
  id: string;
  tool_name: string;
  reason: string;
  timestamp: number;
}

/**
 * Event emitted when the ApprovalManager policy changes (mode, thresholds, lists).
 * Lets subscribers (UI, event log) react without polling getPolicy().
 */
export interface ApprovalPolicyChangedEvent {
  mode: 'always_ask' | 'auto_approve_safe' | 'auto_reject_unsafe' | 'never_ask';
  previousMode: 'always_ask' | 'auto_approve_safe' | 'auto_reject_unsafe' | 'never_ask';
  timestamp: number;
}

// DiffTracker event payloads

export interface ChangeAddedEvent {
  change_id: string;
  type: string;
  operation: string;
  target: unknown;
}

export interface ChangesRetrievedEvent {
  filter: any;
  count: number;
}

export interface RollbackStartedEvent {
  change_id: string;
  type: string;
}

export interface BatchRollbackStartedEvent {
  change_ids: string[];
  count: number;
}

export interface SessionRollbackStartedEvent {
  session_id?: string;
  turn_id?: string;
  until?: number;
}

export interface RollbackCompletedEvent {
  change_id: string;
  success: boolean;
}

export interface SnapshotCreatedEvent {
  snapshot_id: string;
  session_id: string;
  turn_id: string;
  change_count: number;
}

export interface SnapshotRestoredEvent {
  snapshot_id: string;
  change_count: number;
}

export interface ChangesClearedEvent {
  session_id?: string;
  turn_id?: string;
  cleared_count: number;
}

// Tool registry event payloads

export interface ToolRegisteredEvent {
  tool_name: string;
  category?: string;
  version?: string;
  registration_time?: number;
}

export interface ToolUnregisteredEvent {
  tool_name: string;
  unregistration_time?: number;
}

export interface ToolExposureUpdatedEvent {
  session_id?: string;
  dynamic_enabled: boolean;
  always_count: number;
  deferred_count: number;
  hidden_count: number;
  selected_count: number;
  estimated_deferred_schema_chars: number;
  estimated_deferred_schema_tokens: number;
  threshold_tokens?: number;
  selected_tools?: string[];
}

export interface ToolExecutionStartEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  turn_id?: string;
  start_time?: number;
  params?: Record<string, unknown>;
}

export interface ToolExecutionEndEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  success: boolean;
  duration?: number;
}

export interface ToolExecutionErrorEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  turn_id?: string;
  code?: string;
  error: string;
  details?: unknown;
  duration?: number;
}

export interface ToolExecutionTimeoutEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  turn_id?: string;
  code?: string;
  error?: string;
  details?: unknown;
  timeout_ms: number;
  duration?: number;
}

export interface ToolExecutionProgressEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  turn_id?: string;
  progress_data: import('../../tools/runtimeMetadata').ToolProgressData;
  timestamp: number;
}

// Reasoning stream event payloads

export interface ReasoningSummaryDeltaEvent {
  delta: string;
}

export interface ReasoningContentDeltaEvent {
  delta: string;
}

export interface ReasoningSummaryPartAddedEvent {
  part_index?: number;
}

// Turn lifecycle event payloads

export interface TurnStartedEvent {
  session_id?: string;
  turn_id?: string;
}

export interface TurnCompleteEvent {
  session_id?: string;
  turn_id?: string;
  success?: boolean;
}

/** Track 24.3: predicted next user message for one-tap accept (ext/desktop). */
export interface PromptSuggestionEvent {
  suggestion: string;
}

export interface ContextUpdatedEvent {
  session_id?: string;
  context_type?: string;
}

export interface TurnRetryEvent {
  turn_id?: string;
  attempt?: number;
  reason?: string;
}

// Track 12: rate-limit resilience event payloads

/**
 * Emitted before a long unattended wait for a rate-limit window to reset, so
 * a remote operator sees "waiting N ms for limit reset" instead of an opaque
 * failure.
 */
export interface RateLimitWaitingEvent {
  /** Milliseconds the agent will wait before the next attempt. */
  delay_ms: number;
  /** Persistent attempt counter (not the attended retry count). */
  attempt: number;
  /** HTTP status that triggered the wait (429 / 529), if known. */
  status_code?: number;
  /** Classified error kind: 'rate_limit' | 'overloaded' | 'server' | ... */
  kind: string;
}

/**
 * Early warning that quota is being consumed faster than the window sustains
 * (time-relative threshold) or that a static threshold was crossed.
 */
export interface RateLimitWarningEvent {
  /** Which window: 'primary' | 'secondary'. */
  window: string;
  /** Percent of the window consumed (0-100). */
  used_percent: number;
  /** Fraction of the window elapsed (0-1), when computable. */
  time_progress?: number;
  /** Seconds until the window resets, when known. */
  resets_in_seconds?: number;
  /** Human-readable summary for surfacing in the UI/transcript. */
  message: string;
}

/**
 * Emitted when sustained provider overload forces a model downgrade. Never
 * silent — output quality changed.
 */
export interface ModelDowngradedEvent {
  from_model?: string;
  to_model: string;
  reason: string;
}

// Browser action event payloads

export interface DOMActionStartEvent {
  action: string;
  selector?: string;
  value?: string;
  options?: Record<string, unknown>;
}

export interface StorageActionStartEvent {
  action: string;
  key?: string;
  value?: unknown;
  area?: string;
}

export interface NavigationActionStartEvent {
  action: string;
  url?: string;
  options?: Record<string, unknown>;
}

// Service routing event payloads

export interface ServiceResponseEvent {
  /** Correlates to ServiceRequest.requestId */
  requestId: string;
  /** Echo of the service path */
  service: string;
  /** Whether the service call succeeded */
  success: boolean;
  /** Response payload (on success) */
  data?: unknown;
  /** Error message (on failure) */
  error?: string;
}

export interface GenericStateUpdateEvent {
  sessionId?: string;
  tabId?: number;
  [key: string]: unknown;
}

export interface DesktopRuntimeAuthStateUpdateEvent {
  scope: 'desktop-runtime';
  kind: 'auth.stateChanged';
  auth: unknown;
  [key: string]: unknown;
}

export interface DesktopRuntimeAccessStateUpdateEvent {
  scope: 'desktop-runtime';
  kind: 'agent.accessChanged';
  access: unknown;
  [key: string]: unknown;
}

export type StateUpdateEvent =
  | DesktopRuntimeAuthStateUpdateEvent
  | DesktopRuntimeAccessStateUpdateEvent
  | GenericStateUpdateEvent;

// Hook system event payloads

export interface HookFiredEvent {
  hook_event_name: string;
  hook_count: number;
  tool_name?: string;
}

export interface HookBlockedEvent {
  hook_event_name: string;
  tool_name?: string;
  stop_reason?: string;
}

export interface HookResultEvent {
  hook_event_name: string;
  hook_id: string;
  execution_id: string;
  source: string;
  command_type: string;
  outcome: string;
  duration_ms: number;
  tool_name?: string;
  exit_code?: number;
  blocked?: boolean;
  permission_decision?: 'approve' | 'block';
  updated_input?: boolean;
  updated_output?: boolean;
  additional_context?: boolean;
  error?: string;
}

// Sub-agent lifecycle event payloads

export interface SubAgentStartEvent {
  runId: string;
  subAgentType: string;
  agentType?: string;
  contextMode?: string;
  executionMode?: string;
  description: string;
}

export interface SubAgentCompleteEvent {
  runId: string;
  subAgentType: string;
  agentType?: string;
  contextMode?: string;
  executionMode?: string;
  turnCount: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  duration: number;
}

export interface SubAgentErrorEvent {
  runId?: string;
  subAgentType?: string;
  error: string;
}

export interface SubAgentWarningEvent {
  runId: string;
  subAgentType: string;
  warning: string;
}
