/**
 * Visual Effect Controller Public API Contract
 *
 * Defines the public interface for the VisualEffectController component
 * that manages overlay, cursor animations, and ripple effects.
 *
 * @module contracts/visual-effect-controller
 * @version 1.0.0
 */

import type {
  VisualEffectEvent,
  AgentActionType,
} from './domtool-events';

// ============================================================================
// Configuration Interfaces
// ============================================================================

/**
 * Ripple effect configuration
 */
export interface RippleEffectConfig {
  /**
   * Ripple radius in pixels
   * @default 20
   * @min 10
   * @max 100
   */
  radius: number;

  /**
   * Ripple intensity
   * @default 0.14
   * @min 0.0
   * @max 1.0
   */
  strength: number;

  /**
   * WebGL texture resolution (must be power of 2)
   * @default 256
   */
  resolution: number;

  /**
   * Wave perturbation factor
   * @default 0.03
   * @min 0.0
   * @max 0.1
   */
  perturbance: number;
}

/**
 * Visual effects system configuration
 */
export interface VisualEffectConfig {
  /**
   * Enable/disable cursor animations
   * @default true
   */
  enableCursorAnimation?: boolean;

  /**
   * Enable/disable ripple effects
   * @default true
   */
  enableRippleEffects?: boolean;

  /**
   * Enable/disable input-blocking overlay
   * @default true
   */
  enableOverlay?: boolean;

  /**
   * Minimum cursor animation duration in milliseconds
   * @default 300
   */
  cursorMinDuration?: number;

  /**
   * Maximum cursor animation duration in milliseconds
   * @default 1500
   */
  cursorMaxDuration?: number;

  /**
   * Maximum event queue size
   * @default 10
   */
  queueMaxSize?: number;

  /**
   * Queue size threshold that triggers speed boost
   * @default 3
   */
  queueSpeedBoostThreshold?: number;

  /**
   * Ripple effect configuration
   */
  rippleConfig?: Partial<RippleEffectConfig>;
}

// ============================================================================
// State Interfaces
// ============================================================================

/**
 * Current state of the visual effects system
 */
export interface VisualEffectState {
  /**
   * Whether visual effects have been initialized
   */
  initialized: boolean;

  /**
   * Whether initialization failed
   */
  initializationFailed: boolean;

  /**
   * Whether agent session is active
   */
  agentSessionActive: boolean;

  /**
   * Whether overlay is visible
   */
  overlayVisible: boolean;

  /**
   * Whether user has taken over (overlay hidden, input enabled)
   */
  takeoverActive: boolean;

  /**
   * Whether cursor animation is currently running
   */
  cursorAnimating: boolean;

  /**
   * Number of queued events
   */
  queuedEventCount: number;

  /**
   * Whether ripple effects are available (WebGL supported)
   */
  rippleEffectsAvailable: boolean;
}

/**
 * Cursor position in viewport coordinates
 */
export interface CursorPosition {
  /**
   * X coordinate in viewport pixels
   */
  x: number;

  /**
   * Y coordinate in viewport pixels
   */
  y: number;

  /**
   * Timestamp when position was set
   */
  timestamp: number;
}

// ============================================================================
// Event Listener Types
// ============================================================================

/**
 * Callback for state change events
 */
export type StateChangeCallback = (state: VisualEffectState) => void;

/**
 * Callback for cursor position updates
 */
export type CursorUpdateCallback = (position: CursorPosition) => void;

/**
 * Callback for error events
 */
export type ErrorCallback = (error: Error) => void;

// ============================================================================
// Visual Effect Controller Interface
// ============================================================================

/**
 * Public API for the Visual Effect Controller
 *
 * This is the main interface for interacting with the visual effects system.
 * Content scripts can use this to control effects programmatically.
 */
export interface IVisualEffectController {
  /**
   * Initialize the visual effects system
   *
   * MUST be called before any other methods.
   * Creates Shadow DOM, initializes ripple effects, sets up event listeners.
   *
   * @param config - Configuration options
   * @throws Error if initialization fails (logged, not propagated)
   *
   * @example
   * const controller = new VisualEffectController();
   * await controller.initialize({
   *   enableCursorAnimation: true,
   *   enableRippleEffects: true,
   * });
   */
  initialize(config?: VisualEffectConfig): Promise<void>;

  /**
   * Clean up and destroy the visual effects system
   *
   * Removes all DOM elements, stops animations, clears event listeners.
   * MUST be called when unloading content script.
   *
   * @example
   * controller.destroy();
   */
  destroy(): void;

  /**
   * Get current state of visual effects system
   *
   * @returns Current state
   *
   * @example
   * const state = controller.getState();
   * console.log('Agent active:', state.agentSessionActive);
   */
  getState(): Readonly<VisualEffectState>;

  /**
   * Manually trigger agent start
   *
   * Normally triggered by DomTool events, but can be called manually.
   * Shows overlay, initializes cursor position.
   *
   * @example
   * controller.startAgentSession();
   */
  startAgentSession(): void;

  /**
   * Manually trigger agent stop
   *
   * Normally triggered by DomTool events or "Stop Agent" button.
   * Hides overlay, clears queue, stops animations.
   *
   * @example
   * controller.stopAgentSession();
   */
  stopAgentSession(): void;

  /**
   * Manually trigger user takeover
   *
   * Normally triggered by "Take Over" button.
   * Hides overlay, keeps effects active for agent actions.
   *
   * @example
   * controller.takeOver();
   */
  takeOver(): void;

  /**
   * Manually trigger cursor animation and ripple effect
   *
   * Normally triggered by DomTool events.
   * Useful for testing or manual control.
   *
   * @param action - Type of action (affects ripple appearance)
   * @param x - Target x coordinate in viewport pixels
   * @param y - Target y coordinate in viewport pixels
   *
   * @example
   * controller.animateAction('click', 500, 300);
   */
  animateAction(action: AgentActionType, x: number, y: number): void;

  /**
   * Manually trigger undulate effect
   *
   * Normally triggered by DomTool serialize events.
   * Creates 20 random ripples across the viewport.
   *
   * @example
   * controller.undulate();
   */
  undulate(): void;

  /**
   * Subscribe to state changes
   *
   * Callback invoked whenever visual effects state changes.
   *
   * @param callback - State change callback
   * @returns Unsubscribe function
   *
   * @example
   * const unsubscribe = controller.onStateChange((state) => {
   *   console.log('State changed:', state);
   * });
   * // Later...
   * unsubscribe();
   */
  onStateChange(callback: StateChangeCallback): () => void;

  /**
   * Subscribe to cursor position updates
   *
   * Callback invoked on every animation frame during cursor movement.
   * Useful for debugging or external visualizations.
   *
   * @param callback - Cursor update callback
   * @returns Unsubscribe function
   *
   * @example
   * const unsubscribe = controller.onCursorUpdate((pos) => {
   *   console.log('Cursor at:', pos.x, pos.y);
   * });
   */
  onCursorUpdate(callback: CursorUpdateCallback): () => void;

  /**
   * Subscribe to error events
   *
   * Callback invoked when errors occur in visual effects system.
   * Errors are caught and logged, but this allows external error tracking.
   *
   * @param callback - Error callback
   * @returns Unsubscribe function
   *
   * @example
   * const unsubscribe = controller.onError((error) => {
   *   console.error('Visual effect error:', error);
   * });
   */
  onError(callback: ErrorCallback): () => void;
}

// ============================================================================
// Factory Function Type
// ============================================================================

/**
 * Factory function to create Visual Effect Controller instance
 *
 * @param targetDocument - Document to inject effects into (defaults to document)
 * @returns Visual Effect Controller instance
 *
 * @example
 * import { createVisualEffectController } from './visual-effect-controller';
 *
 * const controller = createVisualEffectController();
 * await controller.initialize();
 */
export type VisualEffectControllerFactory = (
  targetDocument?: Document
) => IVisualEffectController;

// ============================================================================
// Constants
// ============================================================================

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<VisualEffectConfig> = {
  enableCursorAnimation: true,
  enableRippleEffects: true,
  enableOverlay: true,
  cursorMinDuration: 300,
  cursorMaxDuration: 1500,
  queueMaxSize: 10,
  queueSpeedBoostThreshold: 3,
  rippleConfig: {
    radius: 20,
    strength: 0.14,
    resolution: 256,
    perturbance: 0.03,
  },
};

/**
 * Performance constants
 */
export const PERFORMANCE_CONSTANTS = {
  /**
   * Target frame rate for cursor animations
   */
  TARGET_FPS: 60,

  /**
   * Speed boost multiplier when queue > threshold
   */
  SPEED_BOOST_MULTIPLIER: 1.5,

  /**
   * Maximum memory budget for visual effects (bytes)
   */
  MAX_MEMORY_BYTES: 5 * 1024 * 1024, // 5MB
} as const;
