/**
 * App-Server Channel Adapter
 *
 * ChannelAdapter for the desktop app-server. Receives agent events for sessions
 * owned by app-server connections (routed by ServerAgentBootstrap's session
 * ownership map) and fans them out to the right connections, filtered by:
 *   - authenticated connection,
 *   - event scope (EVENT_SCOPE_MAP / BROADCAST_EVENTS),
 *   - session ownership / subscription.
 *
 * Submissions flow through the shared chat handlers (not this channel's
 * onSubmission), so onSubmission is a no-op sink here.
 *
 * @module app-server/AppServerChannel
 */

import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import type {
  ChannelType,
  ChannelCapabilities,
  ChannelEvent,
  SubmissionHandler,
  ConnectionState,
} from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import { makeEvent, EVENT_SCOPE_MAP, BROADCAST_EVENTS } from '@applepi/ws-server';
import { redactEventMsgSecrets } from '@/server/security/eventRedaction';
import type { AppServerConnectionRegistry } from './AppServerConnectionRegistry';

export const APP_SERVER_CHANNEL_ID = 'desktop-app-server';

export class AppServerChannel implements ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType = 'websocket';

  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private eventSeq = 0;

  constructor(
    private readonly registry: AppServerConnectionRegistry,
    channelId: string = APP_SERVER_CHANNEL_ID,
  ) {
    this.channelId = channelId;
  }

  async initialize(): Promise<void> {
    this.connectionState = 'connected';
  }

  async shutdown(): Promise<void> {
    this.submissionHandler = null;
    this.connectionState = 'disconnected';
  }

  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  /**
   * Fan an agent event out to eligible connections.
   */
  async sendEvent(event: ChannelEvent, targetClientId?: string): Promise<void> {
    const msg = redactEventMsgSecrets(event.msg);
    const eventName = eventMsgToName(msg);
    const runId = extractRunId(msg);
    const seq = ++this.eventSeq;

    const basePayload: Record<string, unknown> = { ...(msg as Record<string, unknown>) };
    if (event.sessionId) basePayload.sessionId = event.sessionId;
    if (runId) basePayload.runId = runId;
    const frame = JSON.stringify(makeEvent(eventName, basePayload, seq));

    for (const conn of this.registry.all()) {
      if (!conn.authenticated) continue;
      if (targetClientId && conn.connectionId !== targetClientId) continue;
      if (!isScopeEligible(eventName, conn.scopes)) continue;
      if (!isSessionEligible(event.sessionId, conn)) continue;

      try {
        conn.socket.send(frame);
      } catch (err) {
        console.error(`[AppServerChannel] send to ${conn.connectionId} failed:`, err);
      }
    }
  }

  supportsStreaming(): boolean {
    return true;
  }
  supportsApprovals(): boolean {
    return true;
  }
  supportsMedia(): boolean {
    return false;
  }
  supportsServices(): boolean {
    return true;
  }
  getCapabilities(): ChannelCapabilities {
    return {
      streaming: this.supportsStreaming(),
      approvals: this.supportsApprovals(),
      media: this.supportsMedia(),
      services: this.supportsServices(),
    };
  }
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }
  async close(): Promise<void> {
    return this.shutdown();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Filtering helpers (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────

export function isScopeEligible(eventName: string, scopes: string[]): boolean {
  if (BROADCAST_EVENTS.has(eventName)) return true;
  const required = EVENT_SCOPE_MAP[eventName];
  if (!required) return true; // unscoped events are visible to authenticated connections
  return scopes.includes(required);
}

export function isSessionEligible(
  sessionId: string | undefined,
  conn: { sessionKey?: string; subscriptions: Set<string> },
): boolean {
  // Events without a session (global/runtime) reach all connections.
  if (!sessionId) return true;
  if (conn.sessionKey === sessionId) return true;
  return conn.subscriptions.has(sessionId);
}

export function extractRunId(msg: EventMsg): string | undefined {
  const data = (msg as { data?: { submission_id?: string; turn_id?: string } }).data;
  return data?.submission_id ?? data?.turn_id;
}

export function eventMsgToName(event: EventMsg): string {
  if (
    event.type === 'AgentMessageDelta' ||
    event.type === 'AgentMessage' ||
    event.type === 'AgentReasoning' ||
    event.type === 'AgentReasoningDelta'
  ) {
    return 'chat';
  }
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
  if (event.type === 'ExecApprovalRequest' || event.type === 'ApplyPatchApprovalRequest') {
    return 'exec.approval.requested';
  }
  if (event.type === 'Error' || event.type === 'StreamError') {
    return 'health';
  }
  if (event.type === 'ServiceResponse') return 'service.response';
  if (event.type === 'StateUpdate') return 'state.update';
  return event.type;
}
