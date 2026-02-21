/**
 * Easing Functions for Cursor Animation
 *
 * Provides smooth animation curves for cursor movement transitions.
 * All functions take a normalized time value (0-1) and return a normalized progress value (0-1).
 *
 * @module ui_effect/utils/easingFunctions
 */

/**
 * Ease In-Out Cubic
 *
 * Smooth acceleration at the start and deceleration at the end.
 * Creates a natural-feeling animation curve.
 *
 * @param t - Normalized time (0-1)
 * @returns Normalized progress (0-1)
 *
 * @example
 * const progress = easeInOutCubic(0.5); // Returns ~0.5 (midpoint)
 * const progress = easeInOutCubic(0.25); // Returns ~0.156 (slower at start)
 * const progress = easeInOutCubic(0.75); // Returns ~0.844 (slower at end)
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Ease Out Quadratic
 *
 * Fast start with gradual deceleration.
 * Useful for cursor arriving at target with precision.
 *
 * @param t - Normalized time (0-1)
 * @returns Normalized progress (0-1)
 *
 * @example
 * const progress = easeOutQuad(0.5); // Returns 0.75 (fast initial movement)
 * const progress = easeOutQuad(0.9); // Returns 0.99 (slow precision approach)
 */
export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Linear Easing
 *
 * Constant speed throughout animation.
 * No acceleration or deceleration.
 *
 * @param t - Normalized time (0-1)
 * @returns Normalized progress (0-1)
 *
 * @example
 * const progress = linear(0.5); // Returns 0.5 (constant speed)
 */
export function linear(t: number): number {
  return t;
}

/**
 * Easing function type
 */
export type EasingFunction = (t: number) => number;

/**
 * Available easing functions by name
 */
export const EASING_FUNCTIONS = {
  easeInOutCubic,
  easeOutQuad,
  linear,
} as const;

/**
 * Default easing function for cursor animation
 */
export const DEFAULT_EASING: EasingFunction = easeInOutCubic;
