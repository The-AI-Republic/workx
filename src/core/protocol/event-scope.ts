/**
 * Event Scope Classification
 *
 * Static mapping of EventMsg.type to its routing scope.
 * - 'thread': Event targets a specific session/thread. Must have sessionId to be routable.
 * - 'channel': Event targets the channel UI itself (settings, status, lifecycle).
 *
 * @module core/protocol/event-scope
 */

export type EventScope = 'thread' | 'channel';

const EVENT_SCOPE_MAP: Record<string, EventScope> = {
  // Thread-scoped: conversation/turn lifecycle
  'TaskStarted': 'thread',
  'TaskComplete': 'thread',
  'TaskFailed': 'thread',
  'TurnStarted': 'thread',
  'TurnComplete': 'thread',
  'TurnAborted': 'thread',
  'Interrupted': 'thread',

  // Thread-scoped: streaming content
  'AgentMessage': 'thread',
  'AgentMessageDelta': 'thread',
  'UserMessage': 'thread',
  'AgentReasoning': 'thread',
  'AgentReasoningDelta': 'thread',
  'AgentReasoningRawContent': 'thread',
  'AgentReasoningRawContentDelta': 'thread',
  'AgentReasoningSectionBreak': 'thread',
  'ReasoningSummaryDelta': 'thread',
  'ReasoningContentDelta': 'thread',
  'ReasoningSummaryPartAdded': 'thread',

  // Thread-scoped: tool execution
  'ToolExecutionStart': 'thread',
  'ToolExecutionEnd': 'thread',
  'ToolExecutionError': 'thread',
  'ToolExecutionTimeout': 'thread',
  'ToolExecutionProgress': 'thread',
  'McpToolCallBegin': 'thread',
  'McpToolCallEnd': 'thread',
  'ExecCommandBegin': 'thread',
  'ExecCommandOutputDelta': 'thread',
  'ExecCommandEnd': 'thread',
  'WebSearchBegin': 'thread',
  'WebSearchEnd': 'thread',

  // Thread-scoped: approvals
  'ExecApprovalRequest': 'thread',
  'ApplyPatchApprovalRequest': 'thread',
  'ApprovalRequested': 'thread',
  'ApprovalGranted': 'thread',
  'ApprovalDenied': 'thread',
  'ApprovalAutoApproved': 'thread',
  // Channel-scoped: global approval-policy setting change (not per-conversation)
  'ApprovalPolicyChanged': 'channel',
  'PatchApplyBegin': 'thread',
  'PatchApplyEnd': 'thread',

  // Thread-scoped: browser actions
  'DOMActionStart': 'thread',
  'StorageActionStart': 'thread',
  'NavigationActionStart': 'thread',

  // Thread-scoped: diff tracking
  'ChangeAdded': 'thread',
  'ChangesRetrieved': 'thread',
  'RollbackStarted': 'thread',
  'BatchRollbackStarted': 'thread',
  'SessionRollbackStarted': 'thread',
  'RollbackCompleted': 'thread',
  'SnapshotCreated': 'thread',
  'SnapshotRestored': 'thread',
  'ChangesCleared': 'thread',

  // Thread-scoped: other per-conversation events
  'TurnDiff': 'thread',
  'TurnRetry': 'thread',
  'ContextUpdated': 'thread',
  'CompactionCompleted': 'thread',
  'EnteredReviewMode': 'thread',
  'ExitedReviewMode': 'thread',
  'PlanUpdate': 'thread',
  'TaskUpdate': 'thread',
  'BackgroundTaskStarted': 'thread',
  'BackgroundTaskOutputDelta': 'thread',
  'BackgroundTaskStateChanged': 'thread',
  'BackgroundTaskTerminated': 'thread',
  'ConversationPath': 'thread',
  'GetHistoryEntryResponse': 'thread',

  // Channel-scoped: global/settings events
  'BackgroundEvent': 'channel',
  'StateUpdate': 'channel',
  'SessionConfigured': 'channel',
  'Notification': 'channel',
  'ShutdownComplete': 'channel',
  'Error': 'channel',
  'StreamError': 'channel',
  'TokenCount': 'channel',
  'McpListToolsResponse': 'channel',
  'ListCustomPromptsResponse': 'channel',

  // Service routing (handled separately by UIChannelClient)
  'ServiceResponse': 'channel',

  // Tool registry events (channel-scoped — informational, not per-conversation)
  'ToolRegistered': 'channel',
  'ToolUnregistered': 'channel',
};

/**
 * Get the routing scope for an event type.
 * Defaults to 'channel' for unknown event types.
 */
export function getEventScope(type: string): EventScope {
  return EVENT_SCOPE_MAP[type] ?? 'channel';
}
