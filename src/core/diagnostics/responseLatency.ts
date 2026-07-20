/**
 * Opt-in, content-free timing trace for the user-send to first-response path.
 *
 * Enable with WORKX_RESPONSE_LATENCY_DEBUG=true in Node/desktop runtime, or
 * localStorage.WORKX_RESPONSE_LATENCY_DEBUG=true in a browser surface. The
 * trace deliberately accepts numeric/boolean metadata only: prompts, model
 * output, URLs, tool arguments, and credentials cannot enter these logs.
 */

export type ResponseLatencyPhase =
  | 'service_received'
  | 'service_received_duplicate'
  | 'service_ack_accepted'
  | 'service_ack_queued'
  | 'service_ack_rejected'
  | 'manager_enqueue_requested'
  | 'manager_lock_acquired'
  | 'recovery_loaded'
  | 'input_digest_computed'
  | 'thread_index_checked'
  | 'live_thread_index_checked'
  | 'manager_route_live'
  | 'manager_route_queued_capacity'
  | 'manager_route_queued_hydration'
  | 'manager_route_queued_suspension'
  | 'submission_deduplicated'
  | 'submission_queued'
  | 'hydration_started'
  | 'hydration_finished'
  | 'live_submit_started'
  | 'queued_submit_started'
  | 'agent_input_funnel_finished'
  | 'user_prompt_hooks_finished'
  | 'tab_binding_finished'
  | 'execution_context_ready'
  | 'engine_submission_created'
  | 'engine_submission_dequeued'
  | 'engine_input_prepared'
  | 'regular_task_ready'
  | 'task_spawn_requested'
  | 'live_submit_returned'
  | 'queued_submit_returned'
  | 'thread_index_touched'
  | 'task_run_started'
  | 'turn_start_persisted'
  | 'task_page_context_loaded'
  | 'task_started_emitted'
  | 'user_message_persisted'
  | 'turn_input_ready'
  | 'pre_request_compaction_started'
  | 'pre_request_compaction_finished'
  | 'model_turn_requested'
  | 'tools_ready'
  | 'prompt_ready'
  | 'retry_policy_ready'
  | 'turn_context_persisted'
  | 'provider_stream_requested'
  | 'provider_stream_opened'
  | 'first_provider_event'
  | 'first_visible_response'
  | 'completed_without_visible_response'
  | 'submission_rejected'
  | 'submission_failed'
  | 'submission_cancelled';

export type ResponseLatencyMetadata = Readonly<Record<string, number | boolean | undefined>>;

interface TraceState {
  readonly clientMessageId: string;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly seenPhases: Set<ResponseLatencyPhase>;
  lastAtMs: number;
  submissionId?: string;
}

const LOG_PREFIX = '[ResponseLatency]';
const MAX_TRACE_AGE_MS = 10 * 60 * 1000;
const MAX_ACCEPTED_UI_AGE_MS = 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 1000;
const MAX_ACTIVE_TRACES = 256;
const traces = new Map<string, TraceState>();
let enabledOverride: boolean | undefined;

function isEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  if (typeof process !== 'undefined') {
    const value = process.env?.WORKX_RESPONSE_LATENCY_DEBUG;
    if (value === 'true' || value === '1') return true;
  }
  try {
    return typeof localStorage !== 'undefined'
      && (localStorage.getItem('WORKX_RESPONSE_LATENCY_DEBUG') === 'true'
        || localStorage.getItem('WORKX_RESPONSE_LATENCY_DEBUG') === '1');
  } catch {
    return false;
  }
}

function cleanExpired(now: number): void {
  for (const [id, trace] of traces) {
    if (now - trace.lastAtMs > MAX_TRACE_AGE_MS) traces.delete(id);
  }
  while (traces.size >= MAX_ACTIVE_TRACES) {
    const oldest = traces.keys().next().value as string | undefined;
    if (!oldest) break;
    traces.delete(oldest);
  }
}

function safeStartedAt(candidate: number | undefined, now: number): number {
  if (!Number.isFinite(candidate)) return now;
  const value = candidate as number;
  if (value < now - MAX_ACCEPTED_UI_AGE_MS || value > now + MAX_FUTURE_SKEW_MS) return now;
  return value;
}

function emit(
  trace: TraceState,
  phase: ResponseLatencyPhase,
  metadata: ResponseLatencyMetadata,
): void {
  const now = Date.now();
  const payload = {
    ...metadata,
    trace_id: trace.clientMessageId,
    session_id: trace.sessionId,
    ...(trace.submissionId ? { submission_id: trace.submissionId } : {}),
    phase,
    at_ms: now,
    total_ms: Math.max(0, now - trace.startedAtMs),
    step_ms: Math.max(0, now - trace.lastAtMs),
  };
  trace.lastAtMs = now;
  trace.seenPhases.add(phase);
  try {
    console.info(`${LOG_PREFIX} ${JSON.stringify(payload)}`);
  } catch {
    // Diagnostics must never affect the request path.
  }
}

export function startResponseLatencyTrace(input: {
  clientMessageId: string;
  sessionId: string;
  startedAtMs?: number;
}): void {
  if (!isEnabled()) return;
  const now = Date.now();
  cleanExpired(now);
  const existing = traces.get(input.clientMessageId);
  if (existing) {
    emit(existing, 'service_received_duplicate', {});
    return;
  }
  const startedAtMs = safeStartedAt(input.startedAtMs, now);
  const trace: TraceState = {
    clientMessageId: input.clientMessageId,
    sessionId: input.sessionId,
    startedAtMs,
    lastAtMs: startedAtMs,
    seenPhases: new Set(),
  };
  traces.set(input.clientMessageId, trace);
  emit(trace, 'service_received', {
    ui_timestamp_adjusted: startedAtMs !== input.startedAtMs,
  });
}

export function setResponseLatencySubmissionId(
  clientMessageId: string,
  submissionId: string,
): void {
  const trace = traces.get(clientMessageId);
  if (trace) trace.submissionId = submissionId;
}

export function markResponseLatency(
  clientMessageId: string | undefined,
  phase: ResponseLatencyPhase,
  metadata: ResponseLatencyMetadata = {},
): void {
  if (!clientMessageId) return;
  const trace = traces.get(clientMessageId);
  if (trace) emit(trace, phase, metadata);
}

export function markResponseLatencyOnce(
  clientMessageId: string | undefined,
  phase: ResponseLatencyPhase,
  metadata: ResponseLatencyMetadata = {},
): void {
  if (!clientMessageId) return;
  const trace = traces.get(clientMessageId);
  if (trace && !trace.seenPhases.has(phase)) emit(trace, phase, metadata);
}

export function finishResponseLatencyTrace(
  clientMessageId: string | undefined,
  phase: ResponseLatencyPhase,
  metadata: ResponseLatencyMetadata = {},
): void {
  if (!clientMessageId) return;
  const trace = traces.get(clientMessageId);
  if (!trace) return;
  emit(trace, phase, metadata);
  traces.delete(clientMessageId);
}

/** Test-only controls. */
export function _resetResponseLatencyForTesting(): void {
  traces.clear();
  enabledOverride = undefined;
}

export function _setResponseLatencyEnabledForTesting(enabled: boolean): void {
  enabledOverride = enabled;
}

export function _activeResponseLatencyTraceCountForTesting(): number {
  return traces.size;
}
