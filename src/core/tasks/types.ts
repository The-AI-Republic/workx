/**
 * Typed task families — public state model for tracked task execution.
 *
 * See .ai_design/agent_improvements/04_typed_task_families/design.md for
 * the architectural rationale. Track 04 introduces typed task state on top
 * of the existing SessionTask / AgentTask / TaskRunner stack so that
 * concurrent background sub-agents can be tracked uniformly in
 * Session.activeTasks, with append-only output via TaskOutputStore.
 *
 * v1 ships exactly one family: `background_agent`. The discriminated union
 * is intentionally one variant wide so future families (`browser_automation`,
 * `tab_watcher`, `data_extraction`) can join cleanly via `extends TaskStateBase`.
 */

export type TaskType = 'background_agent';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

/**
 * Canonical cumulative token usage shape — used by BackgroundAgentTaskState,
 * TaskNotification, and the inner type of TaskRunner.TaskState.tokenUsageDetail.
 *
 * Distinct from TaskRunner.TaskState.tokenBudget which tracks remaining-capacity
 * for compaction trigger decisions.
 */
export interface TaskTokenUsage {
  input: number;
  output: number;
  /** Cache-hit tokens, if the model supports caching */
  cached?: number;
  /** Derived but stored to avoid re-summing on every read */
  total: number;
}

/**
 * Fields shared by every typed task. Future families extend this.
 *
 * Identity: `id` is stable for the task's lifetime. For background_agent
 * tasks, `id` equals the SubAgentRegistry runId (identity collapse). Future
 * families may diverge.
 *
 * Lifecycle flags:
 * - `notified`: set true when the parent agent has been told this task
 *   reached terminal state (background: via task-notification injection;
 *   foreground: immediately on terminal transition).
 * - `retain`: set true while the UI is actively holding this task open
 *   (e.g., the panel is mounted). Blocks eviction.
 * - `evictAfter`: ms timestamp; eviction is allowed once Date.now() >=
 *   evictAfter, AND notified, AND terminal, AND !retain.
 * - `lastReadAt`: poller heartbeat. Used by the eviction-grace guard
 *   in TaskOutputManager to skip chunks a poller just read.
 */
export interface TaskStateBase {
  id: string;
  type: TaskType;
  status: TaskStatus;
  /**
   * Failure detail for a terminal `failed` task — the underlying model/gateway
   * error message (e.g. "no LLM credit account for this identity"). Undefined
   * unless the task failed. Without this field the background-task UI has no
   * channel for the reason and collapses every failure to a generic status.
   */
  error?: string;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  /** Last seen chunk seq in TaskOutputStore — for delta polling */
  outputOffset: number;
  /** Has the parent been notified of terminal state? */
  notified: boolean;
  /** Background mode flag — separate from `status` so the badge can filter */
  isBackgrounded: boolean;
  /** UI is holding this task — blocks eviction */
  retain: boolean;
  /** Eviction-grace deadline; undefined when retain=true */
  evictAfter?: number;
  /** Last `getDelta` heartbeat — used for eviction-grace skip rule */
  lastReadAt?: number;
}

export interface BackgroundAgentTaskState extends TaskStateBase {
  type: 'background_agent';
  /** Track 40: enum-backed runtime behavior identity */
  agentType?: import('@/tools/AgentTool/agentTypes').AgentType;
  /** Track 40: isolated vs forked-subagent context mode */
  contextMode?: import('@/tools/AgentTool/agentTypes').SubAgentContextMode;
  /** Track 40: foreground/background execution mode */
  executionMode?: import('@/tools/AgentTool/agentTypes').SubAgentExecutionMode;
  /** Joins back to SubAgentRegistry; equals `id` for v1 (identity collapse) */
  runId: string;
  /** Parent session that spawned this sub-agent */
  parentSessionId: string;
  /** The prompt the sub-agent was launched with */
  prompt: string;
  /** Tail of the sub-agent's most recent assistant message (for the badge) */
  lastAgentMessage?: string;
  toolUseCount: number;
  tokenUsage: TaskTokenUsage;
  // pendingMessages is intentionally NOT here — that queue lives on
  // SubAgentRegistry.pendingMessages and is read via
  // SubAgentRegistry.peekMessages(runId) / drainMessages(runId).
  // See design.md Q5 for rationale.
}

/** The discriminated union of all task families. v1 has exactly one variant. */
export type TaskState = BackgroundAgentTaskState;

/**
 * True when status will not transition further. Used by handleTaskAbort,
 * the eviction timer, and registry helpers to reject terminal-to-non-terminal
 * transitions.
 */
export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'killed';
}

export function isBackgroundAgentTask(t: TaskState): t is BackgroundAgentTaskState {
  return t.type === 'background_agent';
}

// ─── Task ID generation ────────────────────────────────────────────────────

const TASK_ID_PREFIX: Record<TaskType, string> = {
  background_agent: 'a',
};

// digits + lowercase = 36^8 ≈ 2.8 trillion combinations
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a unique task ID with a single-character prefix that identifies
 * the family. 9 characters total: 1 prefix + 8 base36 random.
 *
 * Uses Web Crypto (`crypto.getRandomValues`) so it works in service worker,
 * extension, and Node (via globalThis.crypto from Node 19+).
 */
export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIX[type] ?? 'x';
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
  }
  return id;
}
