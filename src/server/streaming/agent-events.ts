/**
 * Agent Event Broadcasting
 *
 * Converts RepublicAgent EventMsg to wire-format agent events with sequence numbering.
 * Handles tool invocations, thinking, and lifecycle events.
 *
 * @module server/streaming/agent-events
 */

import type { EventMsg } from '@/core/protocol/events';
import { makeEvent, type EventFrame } from '@workx/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Sequence numbering
// ─────────────────────────────────────────────────────────────────────────

let _globalSeq = 0;

export function nextSeq(): number {
  return ++_globalSeq;
}

export function resetSeq(): void {
  _globalSeq = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// EventMsg → agent wire event conversion
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert a RepublicAgent EventMsg to a wire-format agent event.
 * Returns null if the event is not an agent-type event.
 */
export function toAgentEvent(event: EventMsg): EventFrame | null {
  const seq = nextSeq();

  switch (event.type) {
    // ── Tool invocations ──────────────────────────────────────────────
    case 'ToolExecutionStart':
      return makeEvent('agent', {
        kind: 'tool.start',
        toolName: event.data.tool_name,
        callId: event.data.call_id,
        params: event.data.params,
      }, seq);

    case 'ToolExecutionEnd':
      return makeEvent('agent', {
        kind: 'tool.end',
        toolName: event.data.tool_name,
        callId: event.data.call_id,
        success: event.data.success,
        duration: event.data.duration,
      }, seq);

    case 'ToolExecutionError':
      return makeEvent('agent', {
        kind: 'tool.error',
        toolName: event.data.tool_name,
        error: event.data.error,
      }, seq);

    case 'ToolExecutionProgress':
      return makeEvent('agent', {
        kind: 'tool.progress',
        toolName: event.data.tool_name,
        callId: event.data.call_id,
        progressData: event.data.progress_data,
        timestamp: event.data.timestamp,
      }, seq);

    // ── MCP tool calls ────────────────────────────────────────────────
    case 'McpToolCallBegin':
      return makeEvent('agent', {
        kind: 'mcp.start',
        toolName: event.data.tool_name,
        callId: event.data.call_id,
        params: event.data.params,
      }, seq);

    case 'McpToolCallEnd':
      return makeEvent('agent', {
        kind: 'mcp.end',
        toolName: event.data.tool_name,
        callId: event.data.call_id,
        result: event.data.result,
        error: event.data.error,
        duration: event.data.duration_ms,
      }, seq);

    // ── Exec commands ─────────────────────────────────────────────────
    case 'ExecCommandBegin':
      return makeEvent('agent', {
        kind: 'exec.start',
        command: event.data.command,
        sessionId: event.data.session_id,
      }, seq);

    case 'ExecCommandEnd':
      return makeEvent('agent', {
        kind: 'exec.end',
        sessionId: event.data.session_id,
        exitCode: event.data.exit_code,
        duration: event.data.duration_ms,
      }, seq);

    case 'ExecCommandOutputDelta':
      return makeEvent('agent', {
        kind: 'exec.output',
        sessionId: event.data.session_id,
        output: event.data.output,
        stream: event.data.stream,
      }, seq);

    // ── Thinking/reasoning ────────────────────────────────────────────
    case 'AgentReasoning':
      return makeEvent('agent', {
        kind: 'thinking',
        content: event.data.content,
      }, seq);

    case 'AgentReasoningDelta':
      return makeEvent('agent', {
        kind: 'thinking.delta',
        delta: event.data.delta,
      }, seq);

    // ── Lifecycle ─────────────────────────────────────────────────────
    case 'TurnStarted':
      return makeEvent('agent', {
        kind: 'turn.started',
        sessionId: event.data.session_id,
        turnId: event.data.turn_id,
      }, seq);

    case 'TurnComplete':
      return makeEvent('agent', {
        kind: 'turn.complete',
        sessionId: event.data.session_id,
        turnId: event.data.turn_id,
        success: event.data.success,
      }, seq);

    case 'TaskStarted':
      return makeEvent('agent', {
        kind: 'task.started',
        model: event.data.model,
        tools: event.data.tools,
      }, seq);

    case 'TaskComplete':
      return makeEvent('agent', {
        kind: 'task.complete',
        turnCount: event.data.turn_count,
        tokenUsage: event.data.token_usage,
      }, seq);

    // ── Approval events ───────────────────────────────────────────────
    case 'ExecApprovalRequest':
      return makeEvent('exec.approval.requested', {
        id: event.data.id,
        command: event.data.command,
        explanation: event.data.explanation,
      }, seq);

    case 'ApplyPatchApprovalRequest':
      return makeEvent('exec.approval.requested', {
        id: event.data.id,
        path: event.data.path,
        patch: event.data.patch,
        explanation: event.data.explanation,
      }, seq);

    default:
      return null;
  }
}
