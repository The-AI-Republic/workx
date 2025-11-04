/**
 * Visual Effects Type Definitions
 *
 * Re-exports types from contracts for convenient import throughout the codebase
 *
 * @module types/visualEffects
 */

// Event types
export type {
  EffectEventType,
  AgentActionType,
  BaseVisualEffectEvent,
  AgentActionEvent,
  AgentSerializeEvent,
  AgentStartEvent,
  AgentStopEvent,
  VisualEffectEvent,
  IDomToolEventEmitter,
  VisualEffectEventDetail,
} from '../content/ui_effect/contracts/domtool-events';

export {
  VISUAL_EFFECT_EVENT_NAME,
  EVENT_CONSTRAINTS,
  isVisualEffectEvent,
  dispatchVisualEffectEvent,
} from '../content/ui_effect/contracts/domtool-events';

// Controller types
export type {
  RippleEffectConfig,
  VisualEffectConfig,
  VisualEffectState,
  CursorPosition,
  StateChangeCallback,
  CursorUpdateCallback,
  ErrorCallback,
  IVisualEffectController,
  VisualEffectControllerFactory,
} from '../content/ui_effect/contracts/visual-effect-controller';

export {
  DEFAULT_CONFIG,
  PERFORMANCE_CONSTANTS,
} from '../content/ui_effect/contracts/visual-effect-controller';
