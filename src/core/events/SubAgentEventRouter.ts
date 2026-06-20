// File: src/core/events/SubAgentEventRouter.ts

import type { EngineEvent } from '../engine/RepublicAgentEngineConfig';
import type { IEventRouter, EventRoutingMetadata } from './IEventRouter';

export class SubAgentEventRouter implements IEventRouter {
  private readonly parentEmitter: (event: EngineEvent) => void;
  private readonly engineId: string;
  private readonly suppressedTypes: Set<string>;

  constructor(options: {
    parentEmitter: (event: EngineEvent) => void;
    engineId: string;
    suppressedTypes?: string[];
  }) {
    this.parentEmitter = options.parentEmitter;
    this.engineId = options.engineId;
    this.suppressedTypes = new Set(options.suppressedTypes ?? [
      'AgentMessageDelta',
      'AgentReasoningDelta',
      // Track 04: chunk-payload-free delta — UI polls TaskOutputStore
      // directly when a panel subscribes; default-suppress to keep the
      // foreground event stream quiet otherwise.
      'BackgroundTaskOutputDelta',
    ]);
  }

  routeEvent(event: EngineEvent, metadata: EventRoutingMetadata): void {
    if (!this.shouldEmit(event.msg.type)) return;

    const namespacedEvent: EngineEvent = {
      ...event,
      id: `${this.engineId}:${event.id}`,
      msg: {
        ...event.msg,
        _subAgent: {
          engineId: this.engineId,
          parentEngineId: metadata.parentEngineId,
          depth: metadata.depth ?? 1,
        },
      },
    };

    this.parentEmitter(namespacedEvent);
  }

  shouldEmit(eventType: string): boolean {
    return !this.suppressedTypes.has(eventType);
  }
}
