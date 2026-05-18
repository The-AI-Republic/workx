import type { EngineEvent } from '@/core/engine/RepublicAgentEngineConfig';
import type { ShadowAgentRuntimeEventData } from '@/core/protocol/events';

export type ShadowAgentEventType =
  | 'ShadowAgentStarted'
  | 'ShadowAgentCompleted'
  | 'ShadowAgentFailed'
  | 'ShadowAgentCancelled'
  | 'ShadowAgentCoalesced'
  | 'ShadowAgentTimedOut'
  | 'ShadowAgentFallbackUsed';

/**
 * Canonical shadow-agent event payload. Aliased to the protocol-level
 * {@link ShadowAgentRuntimeEventData} so the wire type and the emit type
 * cannot drift apart.
 */
export type ShadowAgentEventData = ShadowAgentRuntimeEventData;

export function createShadowAgentEvent(
  type: ShadowAgentEventType,
  data: ShadowAgentEventData,
): EngineEvent {
  return {
    id: crypto.randomUUID(),
    msg: { type, data },
  };
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
