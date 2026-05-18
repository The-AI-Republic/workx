/**
 * TelemetryBridge — turns the existing structured event stream into
 * privacy-typed telemetry, instead of hand-instrumenting call sites.
 *
 * Two taps feed it:
 *  - {@link observe}: the per-session event chokepoint, wired by the
 *    {@link withTelemetry} decorator at `AgentRegistry.createSession`.
 *  - {@link observeScheduler}: the scheduler emitter (a separate emitter
 *    family that bypasses the agent chokepoint), wired by the `tap?`
 *    parameter of `Scheduler.connectToChannel`.
 *
 * Allowlist-only: an unknown/new event type produces nothing, so adding
 * events elsewhere can never accidentally leak. Every string-valued field
 * goes through a `sanitize.ts` marker-typed helper.
 *
 * See `.ai_design/agent_improvements/16_telemetry_analytics/design.md` §6.
 */

import { logEvent, type LogEventMetadata } from './analytics';
import { boundedEnum, numericOnly, sanitizeToolName } from './sanitize';

/** Minimal structural view — the bridge must not break if shapes evolve. */
type LooseEvent = {
  msg: {
    type: string;
    data?: unknown;
    _subAgent?: { depth?: number };
  };
};

type Extractor = (data: Record<string, unknown>) => LogEventMetadata;

const d = (data: unknown): Record<string, unknown> =>
  data && typeof data === 'object' ? (data as Record<string, unknown>) : {};

const ABORT_REASONS = [
  'user_interrupt',
  'automatic_abort',
  'error',
  'user_request',
] as const;
const TRIGGER = ['auto', 'manual'] as const;
const APPROVAL_MODES = [
  'always_ask',
  'auto_approve_safe',
  'auto_reject_unsafe',
  'never_ask',
] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const BG_STATUS = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
] as const;
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'PermissionDenied',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'ConfigChange',
] as const;
const EXEC_STATUS = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
const FAILURE_REASONS = [
  'session_create_failed',
  'no_launcher',
  'launcher_error',
  'agent_error',
  'stale_recovered',
  'mutex_queued',
  'offline',
  'missed',
  'concurrent',
] as const;

/**
 * Curated allowlist (design §6). Each entry extracts ONLY numeric/boolean/
 * bounded-enum fields. Free text, paths, URLs, DOM, model output, prompts,
 * raw command/patch/diff are never read.
 */
const ALLOWLIST: Record<string, { name: string; extract: Extractor }> = {
  TaskStarted: {
    name: 'task.started',
    extract: (x) => ({
      review_mode: typeof x.review_mode === 'boolean' ? x.review_mode : undefined,
      auto_compact: typeof x.auto_compact === 'boolean' ? x.auto_compact : undefined,
      compaction_threshold: numericOnly(x.compaction_threshold),
      tool_count: Array.isArray(x.tools) ? x.tools.length : undefined,
    }),
  },
  TaskComplete: {
    name: 'task.completed',
    extract: (x) => ({
      turn_count: numericOnly(x.turn_count),
      compaction_performed:
        typeof x.compaction_performed === 'boolean'
          ? x.compaction_performed
          : undefined,
      aborted: typeof x.aborted === 'boolean' ? x.aborted : undefined,
      abort_reason: boundedEnum(x.abort_reason as string, ABORT_REASONS),
      total_tokens: numericOnly(
        (d(x.token_usage).total_tokens ?? d(x.token_usage).total) as number,
      ),
    }),
  },
  TurnStarted: { name: 'turn.started', extract: () => ({}) },
  TurnComplete: {
    name: 'turn.completed',
    extract: (x) => ({
      success: typeof x.success === 'boolean' ? x.success : undefined,
    }),
  },
  TurnAborted: {
    name: 'turn.aborted',
    extract: (x) => ({
      reason: boundedEnum(x.reason as string, ABORT_REASONS),
      turn_count: numericOnly(x.turn_count),
    }),
  },
  TurnRetry: {
    name: 'turn.retry',
    extract: (x) => ({ attempt: numericOnly(x.attempt) }),
  },
  CompactionCompleted: {
    name: 'compaction.completed',
    extract: (x) => ({
      success: typeof x.success === 'boolean' ? x.success : undefined,
      tokens_before: numericOnly(x.tokensBefore),
      tokens_after: numericOnly(x.tokensAfter),
      items_trimmed: numericOnly(x.itemsTrimmed),
      compaction_count: numericOnly(x.compactionCount),
      trigger_reason: boundedEnum(x.triggerReason as string, TRIGGER),
    }),
  },
  ToolExecutionStart: {
    name: 'tool.exec.start',
    extract: (x) => ({ tool_name: sanitizeToolName(String(x.tool_name ?? '')) }),
  },
  ToolExecutionEnd: {
    name: 'tool.exec.end',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      success: typeof x.success === 'boolean' ? x.success : undefined,
      duration: numericOnly(x.duration),
    }),
  },
  ToolExecutionError: {
    name: 'tool.exec.error',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      duration: numericOnly(x.duration),
    }),
  },
  ToolExecutionTimeout: {
    name: 'tool.exec.timeout',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      timeout_ms: numericOnly(x.timeout_ms),
    }),
  },
  McpToolCallEnd: {
    name: 'tool.mcp.end',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      duration_ms: numericOnly(x.duration_ms),
    }),
  },
  ApprovalRequested: {
    name: 'approval.requested',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      risk_score: numericOnly(x.risk_score),
      risk_level: boundedEnum(x.risk_level as string, RISK_LEVELS),
    }),
  },
  ApprovalGranted: {
    name: 'approval.granted',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
    }),
  },
  ApprovalDenied: {
    name: 'approval.denied',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
    }),
  },
  ApprovalAutoApproved: {
    name: 'approval.auto_approved',
    extract: (x) => ({
      tool_name: sanitizeToolName(String(x.tool_name ?? '')),
      risk_score: numericOnly(x.risk_score),
      risk_level: boundedEnum(x.risk_level as string, RISK_LEVELS),
    }),
  },
  ApprovalPolicyChanged: {
    name: 'approval.policy_changed',
    extract: (x) => ({
      mode: boundedEnum(x.mode as string, APPROVAL_MODES),
      previous_mode: boundedEnum(x.previousMode as string, APPROVAL_MODES),
    }),
  },
  HookFired: {
    name: 'hook.fired',
    extract: (x) => ({
      hook_event_name: boundedEnum(x.hook_event_name as string, HOOK_EVENTS),
      hook_count: numericOnly(x.hook_count),
      tool_name: x.tool_name
        ? sanitizeToolName(String(x.tool_name))
        : undefined,
    }),
  },
  HookBlocked: {
    name: 'hook.blocked',
    extract: (x) => ({
      hook_event_name: boundedEnum(x.hook_event_name as string, HOOK_EVENTS),
      tool_name: x.tool_name
        ? sanitizeToolName(String(x.tool_name))
        : undefined,
    }),
  },
  TokenCount: {
    name: 'usage.tokens',
    extract: (x) => {
      const info = d(x.info);
      const total = d(info.total_token_usage);
      const last = d(info.last_token_usage);
      const rl = d(x.rate_limits);
      return {
        total_input: numericOnly(total.input_tokens),
        total_output: numericOnly(total.output_tokens),
        total_tokens: numericOnly(total.total_tokens),
        last_total: numericOnly(last.total_tokens),
        ctx_window: numericOnly(info.model_context_window),
        rl_primary_pct: numericOnly(rl.primary_used_percent),
        rl_secondary_pct: numericOnly(rl.secondary_used_percent),
      };
    },
  },
  WebSearchEnd: {
    name: 'web_search.completed',
    extract: (x) => ({ results_count: numericOnly(x.results_count) }),
  },
  ExecCommandEnd: {
    name: 'exec.completed',
    extract: (x) => ({
      exit_code: numericOnly(x.exit_code),
      duration_ms: numericOnly(x.duration_ms),
    }),
  },
  SubAgentStart: {
    name: 'subagent.started',
    extract: (x) => ({ sub_agent_type: sanitizeToolName(String(x.subAgentType ?? '')) }),
  },
  SubAgentComplete: {
    name: 'subagent.completed',
    extract: (x) => ({
      sub_agent_type: sanitizeToolName(String(x.subAgentType ?? '')),
      turn_count: numericOnly(x.turnCount),
      duration: numericOnly(x.duration),
      total_tokens: numericOnly(d(x.tokenUsage).total),
    }),
  },
  SubAgentError: {
    name: 'subagent.failed',
    extract: (x) => ({ sub_agent_type: sanitizeToolName(String(x.subAgentType ?? '')) }),
  },
  BackgroundTaskStateChanged: {
    name: 'bg_task.state_changed',
    extract: (x) => ({
      status: boundedEnum(x.status as string, BG_STATUS),
      prev_status: boundedEnum(x.prevStatus as string, BG_STATUS),
    }),
  },
  BackgroundTaskTerminated: {
    name: 'bg_task.terminated',
    extract: (x) => ({
      status: boundedEnum(x.status as string, BG_STATUS),
      duration_ms: numericOnly(x.durationMs),
    }),
  },
  Error: {
    name: 'error.occurred',
    extract: (x) => ({
      has_code: x.code != null ? true : undefined,
    }),
  },
  StreamError: {
    name: 'error.stream',
    extract: (x) => ({
      retrying: typeof x.retrying === 'boolean' ? x.retrying : undefined,
      attempt: numericOnly(x.attempt),
      max_retries: numericOnly(x.maxRetries),
    }),
  },
  TaskFailed: { name: 'error.task_failed', extract: () => ({}) },
};

function cleanMeta(m: LogEventMetadata): LogEventMetadata {
  const out: LogEventMetadata = {};
  for (const k in m) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export class TelemetryBridge {
  /** Agent-side tap: one event from the per-session chokepoint. */
  observe(event: LooseEvent): void {
    const msg = event?.msg;
    if (!msg || typeof msg.type !== 'string') return;
    const entry = ALLOWLIST[msg.type];
    if (!entry) return; // allowlist-only
    const meta = cleanMeta(entry.extract(d(msg.data)));
    const depth = msg._subAgent?.depth;
    if (typeof depth === 'number') meta.subagent_depth = depth;
    logEvent(entry.name, meta);
  }

  /**
   * Scheduler-side tap: the raw scheduler emitter payload (Shape A execution
   * event or Shape B state event). The stream is telemetry-clean (no free
   * text); we still extract numeric/enum only.
   */
  observeScheduler(raw: Record<string, unknown>): void {
    if (!raw || typeof raw !== 'object') return;
    if ('status' in raw) {
      logEvent(
        'scheduler.execution',
        cleanMeta({
          status: boundedEnum(raw.status as string, EXEC_STATUS),
          failure_reason: boundedEnum(
            raw.failureReason as string,
            FAILURE_REASONS,
          ),
        }),
      );
    } else if ('isPaused' in raw) {
      logEvent(
        'scheduler.state',
        cleanMeta({
          is_paused:
            typeof raw.isPaused === 'boolean' ? raw.isPaused : undefined,
        }),
      );
    }
  }
}

/** Process-wide singleton (telemetry core is itself a module singleton). */
export const telemetryBridge = new TelemetryBridge();

/**
 * Decorator applied at `AgentRegistry.createSession` to both dispatcher
 * branches. Telemetry observation is wrapped in its own try/catch and the
 * real dispatcher ALWAYS runs — `RepublicAgent.emitEvent`'s own catch would
 * otherwise swallow the real event if observe() threw before forwarding.
 */
export function withTelemetry<E extends LooseEvent>(
  real: (event: E) => void | Promise<void>,
): (event: E) => void | Promise<void> {
  return (event: E) => {
    try {
      telemetryBridge.observe(event);
    } catch {
      // never propagate; never block delivery
    }
    return real(event);
  };
}
