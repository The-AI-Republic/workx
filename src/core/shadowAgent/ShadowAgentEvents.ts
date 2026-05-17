import type { EngineEvent } from '@/core/engine/RepublicAgentEngineConfig';
import type {
  ShadowAgentKind,
  ShadowAgentPriority,
  ShadowAgentStatus,
  ShadowFailurePolicy,
} from './types';

export type ShadowAgentEventType =
  | 'ShadowAgentStarted'
  | 'ShadowAgentCompleted'
  | 'ShadowAgentFailed'
  | 'ShadowAgentCancelled'
  | 'ShadowAgentCoalesced'
  | 'ShadowAgentTimedOut'
  | 'ShadowAgentFallbackUsed';

export interface ShadowAgentEventData {
  run_id: string;
  kind: ShadowAgentKind;
  priority: ShadowAgentPriority;
  status?: ShadowAgentStatus;
  duration_ms?: number;
  timeout_ms?: number;
  failure_policy: ShadowFailurePolicy;
  model?: string;
  parent_engine_id?: string;
  child_engine_id?: string;
  dedupe_key?: string;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

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
