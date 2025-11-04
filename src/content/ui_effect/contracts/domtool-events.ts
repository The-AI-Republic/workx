/**
 * DomTool Event Emission Contract
 *
 * Defines the events that DomTool emits to trigger visual effects.
 * These events follow a fire-and-forget pattern - DomTool does NOT wait for responses.
 *
 * @module contracts/domtool-events
 * @version 1.0.0
 */

// ============================================================================
// Event Types
// ============================================================================

/**
 * Types of visual effect events
 */
export type EffectEventType =
  | 'agent-action'      // Agent performed DOM action (click, type, keypress)
  | 'agent-serialize'   // Agent is serializing DOM (triggers undulate effect)
  | 'agent-start'       // Agent session started (show overlay)
  | 'agent-stop';       // Agent session stopped (hide all effects)

/**
 * Types of agent DOM actions
 */
export type AgentActionType =
  | 'click'
  | 'type'
  | 'keypress';

// ============================================================================
// Event Payload Interfaces
// ============================================================================

/**
 * Base event payload structure
 */
export interface BaseVisualEffectEvent {
  /**
   * Type of effect event
   */
  type: EffectEventType;

  /**
   * Event creation timestamp (Date.now())
   */
  timestamp: number;
}

/**
 * Event payload for agent DOM actions (click, type, keypress)
 */
export interface AgentActionEvent extends BaseVisualEffectEvent {
  type: 'agent-action';

  /**
   * Specific DOM action performed
   */
  action: AgentActionType;

  /**
   * Target DOM element reference (null if cross-origin iframe or inaccessible)
   */
  element: Element | null;

  /**
   * Element bounding box fallback when element is inaccessible
   * Visual effects use this to calculate screen coordinates
   */
  boundingBox: DOMRect | null;
}

/**
 * Event payload for DOM serialization operations
 */
export interface AgentSerializeEvent extends BaseVisualEffectEvent {
  type: 'agent-serialize';
}

/**
 * Event payload for agent session start
 */
export interface AgentStartEvent extends BaseVisualEffectEvent {
  type: 'agent-start';
}

/**
 * Event payload for agent session stop
 */
export interface AgentStopEvent extends BaseVisualEffectEvent {
  type: 'agent-stop';
}

/**
 * Union type of all possible visual effect events
 */
export type VisualEffectEvent =
  | AgentActionEvent
  | AgentSerializeEvent
  | AgentStartEvent
  | AgentStopEvent;

// ============================================================================
// DomTool Event Emitter Contract
// ============================================================================

/**
 * Contract for DomTool to emit visual effect events
 *
 * DomTool MUST implement this interface to trigger visual effects.
 * All methods are fire-and-forget - no return values, no awaiting.
 */
export interface IDomToolEventEmitter {
  /**
   * Emit event when agent starts a session
   * Triggers overlay display
   *
   * MUST be called when agent begins DOM operations
   *
   * @example
   * domTool.emitAgentStart();
   */
  emitAgentStart(): void;

  /**
   * Emit event when agent stops a session
   * Triggers removal of all visual effects
   *
   * MUST be called when agent ends or user stops agent
   *
   * @example
   * domTool.emitAgentStop();
   */
  emitAgentStop(): void;

  /**
   * Emit event when agent performs DOM action
   * Triggers cursor animation + ripple effect
   *
   * MUST be called AFTER action execution, not before
   * MUST provide element OR boundingBox, preferably element
   *
   * @param action - Type of DOM action performed
   * @param element - Target element reference (null if inaccessible)
   * @param boundingBox - Element bounding box fallback
   *
   * @example
   * // Preferred: provide element reference
   * const element = document.getElementById('login-button');
   * domTool.emitAgentAction('click', element, null);
   *
   * @example
   * // Fallback: provide bounding box for inaccessible elements
   * const bbox = iframeElement.getBoundingClientRect();
   * domTool.emitAgentAction('click', null, bbox);
   */
  emitAgentAction(
    action: AgentActionType,
    element: Element | null,
    boundingBox: DOMRect | null
  ): void;

  /**
   * Emit event when agent serializes DOM
   * Triggers undulate effect (20 random ripples)
   *
   * MUST be called when get_serialized_dom executes
   *
   * @example
   * async getSerializedDom(): Promise<SerializedDom> {
   *   this.emitAgentSerialize(); // Fire and forget
   *   return this.serializer.serialize();
   * }
   */
  emitAgentSerialize(): void;
}

// ============================================================================
// Event Dispatching Helpers
// ============================================================================

/**
 * CustomEvent detail type for visual effects
 */
export interface VisualEffectEventDetail {
  event: VisualEffectEvent;
}

/**
 * CustomEvent name for visual effect events
 */
export const VISUAL_EFFECT_EVENT_NAME = 'browserx:visual-effect';

/**
 * Type guard to check if event is valid VisualEffectEvent
 *
 * @param event - Event to validate
 * @returns True if event matches VisualEffectEvent structure
 */
export function isVisualEffectEvent(event: any): event is VisualEffectEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }

  if (!['agent-action', 'agent-serialize', 'agent-start', 'agent-stop'].includes(event.type)) {
    return false;
  }

  if (typeof event.timestamp !== 'number') {
    return false;
  }

  // Validate agent-action specific fields
  if (event.type === 'agent-action') {
    const actionEvent = event as AgentActionEvent;
    if (!['click', 'type', 'keypress'].includes(actionEvent.action)) {
      return false;
    }
    // Must have element OR boundingBox
    if (!actionEvent.element && !actionEvent.boundingBox) {
      return false;
    }
  }

  return true;
}

/**
 * Helper function to dispatch visual effect event
 *
 * DomTool can use this to dispatch events via CustomEvent API
 *
 * @param event - Visual effect event to dispatch
 * @param target - Event target (defaults to document)
 *
 * @example
 * dispatchVisualEffectEvent({
 *   type: 'agent-action',
 *   action: 'click',
 *   element: buttonElement,
 *   boundingBox: null,
 *   timestamp: Date.now()
 * });
 */
export function dispatchVisualEffectEvent(
  event: VisualEffectEvent,
  target: EventTarget = document
): void {
  const customEvent = new CustomEvent<VisualEffectEventDetail>(
    VISUAL_EFFECT_EVENT_NAME,
    {
      detail: { event },
      bubbles: false,
      cancelable: false,
      composed: true // Allows event to cross shadow DOM boundary
    }
  );

  target.dispatchEvent(customEvent);
}

// ============================================================================
// Validation Constraints
// ============================================================================

/**
 * Validation constraints for event payloads
 */
export const EVENT_CONSTRAINTS = {
  /**
   * Maximum age of events (older events may be dropped)
   */
  MAX_EVENT_AGE_MS: 5000,

  /**
   * Valid event types
   */
  VALID_EVENT_TYPES: ['agent-action', 'agent-serialize', 'agent-start', 'agent-stop'] as const,

  /**
   * Valid action types
   */
  VALID_ACTION_TYPES: ['click', 'type', 'keypress'] as const,
} as const;
