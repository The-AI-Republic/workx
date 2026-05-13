// File: src/core/events/IEventRouter.ts

import type { EngineEvent } from '../engine/RepublicAgentEngineConfig';

export interface EventRoutingMetadata {
  engineId: string;
  parentEngineId?: string;
  depth?: number;
}

export interface IEventRouter {
  /**
   * Route a sub-agent event.
   * Implementation can namespace, filter, or transform events.
   */
  routeEvent(event: EngineEvent, metadata: EventRoutingMetadata): void;

  /**
   * Whether to emit a particular event type.
   * Allows filtering verbose events from sub-agents.
   */
  shouldEmit(eventType: string): boolean;
}
