/**
 * Svelte Stores for Visual Effect State
 *
 * Centralized reactive state management for visual effects components.
 * All stores are ephemeral - no persistence.
 *
 * @module ui_effect/stores
 */

import { writable, type Writable } from 'svelte/store';
import type { CursorPosition, VisualEffectState } from './contracts/visual-effect-controller';
import type { VisualEffectEvent } from './contracts/domtool-events';
import { EffectQueue } from './utils/eventQueue';

/**
 * Cursor animation state
 */
export interface CursorAnimationState {
  /** Animation is in progress */
  isAnimating: boolean;
  /** Animation start position */
  startPosition: CursorPosition | null;
  /** Animation target position */
  targetPosition: CursorPosition | null;
  /** Animation start timestamp */
  startTime: number | null;
  /** Animation duration in milliseconds */
  duration: number;
  /** Easing function name */
  easing: 'easeInOutCubic' | 'easeOutQuad' | 'linear';
}

/**
 * Overlay state
 */
export interface OverlayState {
  /** Overlay is visible */
  visible: boolean;
  /** User has taken over control (overlay removed) */
  takeoverActive: boolean;
  /** Agent session is active */
  agentSessionActive: boolean;
}

/**
 * Current cursor position
 *
 * Reactive store tracking cursor location for animation.
 *
 * @example
 * import { cursorPosition } from './stores';
 *
 * cursorPosition.subscribe(pos => {
 *   console.log('Cursor at:', pos.x, pos.y);
 * });
 *
 * cursorPosition.update(pos => ({ ...pos, x: 100, y: 200 }));
 */
export const cursorPosition: Writable<CursorPosition> = writable({
  x: 0,
  y: 0,
  timestamp: Date.now(),
});

/**
 * Cursor animation state
 *
 * Tracks in-progress cursor animation details.
 *
 * @example
 * import { animationState } from './stores';
 *
 * animationState.update(state => ({
 *   ...state,
 *   isAnimating: true,
 *   startPosition: { x: 0, y: 0, timestamp: Date.now() },
 *   targetPosition: { x: 100, y: 200, timestamp: Date.now() },
 *   startTime: Date.now(),
 *   duration: 500,
 *   easing: 'easeInOutCubic',
 * }));
 */
export const animationState: Writable<CursorAnimationState> = writable({
  isAnimating: false,
  startPosition: null,
  targetPosition: null,
  startTime: null,
  duration: 0,
  easing: 'easeInOutCubic',
});

/**
 * Overlay visibility and takeover state
 *
 * Controls input-blocking overlay and user takeover mode.
 *
 * @example
 * import { overlayState } from './stores';
 *
 * overlayState.subscribe(state => {
 *   if (state.takeoverActive) {
 *     console.log('User has taken over control');
 *   }
 * });
 *
 * // User clicks "Take Over" button
 * overlayState.update(state => ({
 *   ...state,
 *   visible: false,
 *   takeoverActive: true,
 * }));
 */
export const overlayState: Writable<OverlayState> = writable({
  visible: false,
  takeoverActive: false,
  agentSessionActive: false,
});

/**
 * Effect event queue
 *
 * FIFO queue of pending visual effect events.
 * Writable store wrapper around EffectQueue class.
 *
 * @example
 * import { effectQueue } from './stores';
 *
 * let queue: EffectQueue;
 * effectQueue.subscribe(q => { queue = q; });
 *
 * // Enqueue event
 * queue.enqueue(event);
 *
 * // Check status
 * const status = queue.getStatus();
 * if (status.speedBoostActive) {
 *   console.log('Speed boost active');
 * }
 */
export const effectQueue: Writable<EffectQueue> = writable(new EffectQueue());

/**
 * Global visual effect state
 *
 * Aggregated state for the entire visual effects system.
 * Derived from other stores for external consumption.
 *
 * @example
 * import { visualEffectState } from './stores';
 *
 * visualEffectState.subscribe(state => {
 *   console.log('Agent active:', state.agentSessionActive);
 *   console.log('Overlay visible:', state.overlayVisible);
 *   console.log('Cursor position:', state.cursorPosition);
 * });
 */
export const visualEffectState: Writable<VisualEffectState> = writable({
  agentSessionActive: false,
  overlayVisible: false,
  takeoverActive: false,
  cursorPosition: { x: 0, y: 0, timestamp: Date.now() },
  isAnimating: false,
  queuedEventCount: 0,
  lastError: null,
});

/**
 * Reset all stores to initial state
 *
 * Called when agent session ends or on error recovery.
 *
 * @example
 * import { resetStores } from './stores';
 *
 * // Agent session stopped
 * resetStores();
 */
export function resetStores(): void {
  cursorPosition.set({ x: 0, y: 0, timestamp: Date.now() });

  animationState.set({
    isAnimating: false,
    startPosition: null,
    targetPosition: null,
    startTime: null,
    duration: 0,
    easing: 'easeInOutCubic',
  });

  overlayState.set({
    visible: false,
    takeoverActive: false,
    agentSessionActive: false,
  });

  effectQueue.update(queue => {
    queue.clear();
    return queue;
  });

  visualEffectState.set({
    agentSessionActive: false,
    overlayVisible: false,
    takeoverActive: false,
    cursorPosition: { x: 0, y: 0, timestamp: Date.now() },
    isAnimating: false,
    queuedEventCount: 0,
    lastError: null,
  });
}

/**
 * Subscribe to multiple stores and aggregate state
 *
 * Helper to keep visualEffectState in sync with component stores.
 * Called during controller initialization.
 *
 * @returns Unsubscribe function
 *
 * @example
 * const unsubscribe = syncVisualEffectState();
 *
 * // Later, on cleanup
 * unsubscribe();
 */
export function syncVisualEffectState(): () => void {
  const unsubscribers: Array<() => void> = [];

  // Sync cursor position
  unsubscribers.push(
    cursorPosition.subscribe(pos => {
      visualEffectState.update(state => ({ ...state, cursorPosition: pos }));
    })
  );

  // Sync animation state
  unsubscribers.push(
    animationState.subscribe(anim => {
      visualEffectState.update(state => ({ ...state, isAnimating: anim.isAnimating }));
    })
  );

  // Sync overlay state
  unsubscribers.push(
    overlayState.subscribe(overlay => {
      visualEffectState.update(state => ({
        ...state,
        agentSessionActive: overlay.agentSessionActive,
        overlayVisible: overlay.visible,
        takeoverActive: overlay.takeoverActive,
      }));
    })
  );

  // Sync queue count
  unsubscribers.push(
    effectQueue.subscribe(queue => {
      visualEffectState.update(state => ({ ...state, queuedEventCount: queue.size() }));
    })
  );

  // Return combined unsubscribe function
  return () => {
    unsubscribers.forEach(unsub => unsub());
  };
}
