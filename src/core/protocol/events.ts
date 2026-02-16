/**
 * Event types
 */

import type {
  ReviewRequest,
  ResponseItem,
  AskForApproval,
  SandboxPolicy,
  ReasoningEffortConfig,
  ReasoningSummaryConfig,
} from './types';

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
  | { type: 'PlanUpdate'; data: UpdatePlanArgs }
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
  | { type: 'ApprovalDenied'; data: ApprovalDeniedEvent };

// Individual event payload types

export interface ErrorEvent {
  message: string;
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
}

export interface TokenCountEvent {
  info?: TokenUsageInfo;
  rate_limits?: RateLimitSnapshotEvent;
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
}

export interface McpToolCallEndEvent {
  tool_name: string;
  result?: any;
  error?: string;
}

export interface WebSearchBeginEvent {
  query: string;
}

export interface WebSearchEndEvent {
  call_id: string;
  query: string;
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
}

export interface BackgroundEventEvent {
  message: string;
  level?: 'info' | 'warning' | 'error';
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
}

export interface PatchApplyEndEvent {
  path: string;
  success: boolean;
  error?: string;
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
export interface PlanItemArg {
  /** Human-readable step description (recommended 5-7 words) */
  step: string;
  /** Current execution state */
  status: StepStatus;
}

/**
 * Input arguments for the PlanningTool
 */
export interface UpdatePlanArgs {
  /** Optional explanation for plan creation/update */
  explanation?: string;
  /** Ordered list of plan steps */
  plan: PlanItemArg[];
}

export interface TurnAbortedEvent {
  reason: TurnAbortReason;
  submission_id?: string;
  turn_count?: number;
  message?: string;
}

export type TurnAbortReason = 'user_interrupt' | 'automatic_abort' | 'error';

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
  reason: string;
  error?: string;
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
}

/**
 * Event emitted when a tool call is granted by the user
 */
export interface ApprovalGrantedEvent {
  id: string;
  tool_name: string;
  timestamp: number;
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
