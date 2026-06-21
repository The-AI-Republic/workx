/**
 * Agent event → protocol wire-name mapping.
 *
 * Shared by every server-side channel (the headless `ServerChannel` and the
 * desktop `AppServerChannel`) so the mapping cannot drift between them. A
 * divergence is not cosmetic: an event that one channel maps to a scoped wire
 * name (e.g. `chat`/`agent`) but the other leaves as its raw type would fall
 * through `EVENT_SCOPE_MAP` as unscoped and leak to every authenticated
 * connection, and would reach the client under a name it cannot interpret.
 *
 * @module server/channels/eventWireName
 */

import type { EventMsg } from '@/core/protocol/events';

/** Map an agent {@link EventMsg} to its protocol wire event name. */
export function eventMsgToName(event: EventMsg): string {
  // Agent message deltas → chat events
  if (
    event.type === 'AgentMessageDelta' ||
    event.type === 'AgentMessage' ||
    event.type === 'AgentReasoning' ||
    event.type === 'AgentReasoningDelta'
  ) {
    return 'chat';
  }

  // Tool and execution events → agent events
  if (
    event.type === 'ToolExecutionStart' ||
    event.type === 'ToolExecutionEnd' ||
    event.type === 'ToolExecutionProgress' ||
    event.type === 'McpToolCallBegin' ||
    event.type === 'McpToolCallEnd' ||
    event.type === 'ExecCommandBegin' ||
    event.type === 'ExecCommandEnd' ||
    event.type === 'TurnStarted' ||
    event.type === 'TurnComplete' ||
    event.type === 'TaskStarted' ||
    event.type === 'TaskComplete'
  ) {
    return 'agent';
  }

  // Approval events
  if (event.type === 'ExecApprovalRequest' || event.type === 'ApplyPatchApprovalRequest') {
    return 'exec.approval.requested';
  }

  // Health events
  if (event.type === 'Error' || event.type === 'StreamError') {
    return 'health';
  }

  // Service routing events (message_routing_v2)
  if (event.type === 'ServiceResponse') {
    return 'service.response';
  }
  if (event.type === 'StateUpdate') {
    return 'state.update';
  }

  // Default: use the raw type as event name
  return event.type;
}
