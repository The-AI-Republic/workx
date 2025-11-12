/**
 * Effect Event Queue Management
 *
 * FIFO queue for visual effect events with automatic speed boost
 * when queue depth exceeds threshold.
 *
 * Performance constraints:
 * - Maximum queue size: 10 events
 * - Speed boost: 1.5x when queue depth > 3
 * - Auto-dequeue on overflow
 *
 * @module ui_effect/utils/eventQueue
 */

import type { VisualEffectEvent } from '../contracts/domtool-events';

/**
 * Queue processing status
 */
export interface QueueStatus {
  /** Current number of events in queue */
  size: number;
  /** Maximum capacity */
  maxSize: number;
  /** Whether speed boost is active */
  speedBoostActive: boolean;
  /** Current processing rate multiplier */
  processingRate: number;
}

/**
 * Effect event queue configuration
 */
export interface EffectQueueConfig {
  /** Maximum queue size before auto-dequeue (default: 10) */
  maxSize?: number;
  /** Queue depth threshold to trigger speed boost (default: 3) */
  speedBoostThreshold?: number;
  /** Speed multiplier when boost active (default: 1.5) */
  speedBoostMultiplier?: number;
}

/**
 * FIFO queue for visual effect events
 *
 * Manages event queuing with automatic speed boost when queue depth
 * exceeds threshold. Prevents memory overflow by auto-dequeuing oldest
 * events when maximum size is reached.
 *
 * @example
 * const queue = new EffectQueue();
 * queue.enqueue(event1);
 * queue.enqueue(event2);
 *
 * const status = queue.getStatus();
 * // status.speedBoostActive = false (only 2 events)
 *
 * queue.enqueue(event3);
 * queue.enqueue(event4);
 * // status.speedBoostActive = true (4 events > threshold of 3)
 *
 * const next = queue.dequeue();
 * // Returns event1 (FIFO)
 */
export class EffectQueue {
  private items: VisualEffectEvent[] = [];
  private readonly maxSize: number;
  private readonly speedBoostThreshold: number;
  private readonly speedBoostMultiplier: number;

  /**
   * Create new effect queue
   *
   * @param config - Queue configuration options
   */
  constructor(config: EffectQueueConfig = {}) {
    this.maxSize = config.maxSize ?? 10;
    this.speedBoostThreshold = config.speedBoostThreshold ?? 3;
    this.speedBoostMultiplier = config.speedBoostMultiplier ?? 1.5;
  }

  /**
   * Add event to queue
   *
   * If queue is at maximum capacity, automatically dequeues oldest event
   * before adding new event (FIFO overflow handling).
   *
   * @param event - Visual effect event to enqueue
   * @returns Current queue size after enqueue
   *
   * @example
   * const size = queue.enqueue(clickEvent);
   * // size = 1
   */
  enqueue(event: VisualEffectEvent): number {
    // Auto-dequeue oldest event if at capacity
    if (this.items.length >= this.maxSize) {
      this.dequeue();
      console.debug(
        `[EffectQueue] Queue overflow - auto-dequeued oldest event (max size: ${this.maxSize})`
      );
    }

    this.items.push(event);
    return this.items.length;
  }

  /**
   * Remove and return next event from queue
   *
   * Returns oldest event (FIFO).
   *
   * @returns Next event or undefined if queue is empty
   *
   * @example
   * const event = queue.dequeue();
   * if (event) {
   *   processEvent(event);
   * }
   */
  dequeue(): VisualEffectEvent | undefined {
    return this.items.shift();
  }

  /**
   * Get next event without removing it
   *
   * @returns Next event or undefined if queue is empty
   *
   * @example
   * const next = queue.peek();
   * if (next) {
   *   console.log('Next event type:', next.type);
   * }
   */
  peek(): VisualEffectEvent | undefined {
    return this.items[0];
  }

  /**
   * Get current queue size
   *
   * @returns Number of events in queue
   */
  size(): number {
    return this.items.length;
  }

  /**
   * Check if queue is empty
   *
   * @returns true if no events in queue
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Clear all events from queue
   *
   * Used when agent session ends or on error recovery.
   */
  clear(): void {
    this.items = [];
  }

  /**
   * Get current queue status
   *
   * Includes speed boost state based on current queue depth.
   *
   * @returns Queue status with size, capacity, and processing rate
   *
   * @example
   * const status = queue.getStatus();
   * if (status.speedBoostActive) {
   *   console.log('Speed boost active:', status.processingRate + 'x');
   * }
   */
  getStatus(): QueueStatus {
    const speedBoostActive = this.items.length > this.speedBoostThreshold;

    return {
      size: this.items.length,
      maxSize: this.maxSize,
      speedBoostActive,
      processingRate: speedBoostActive ? this.speedBoostMultiplier : 1.0,
    };
  }

  /**
   * Get current processing rate multiplier
   *
   * Returns speed boost multiplier if queue depth exceeds threshold,
   * otherwise returns 1.0 (normal speed).
   *
   * Used by cursor animator to adjust animation duration.
   *
   * @returns Processing rate multiplier (1.0 or speedBoostMultiplier)
   *
   * @example
   * const duration = baseDuration / queue.getProcessingRate();
   * // If speed boost active: duration = baseDuration / 1.5
   */
  getProcessingRate(): number {
    return this.items.length > this.speedBoostThreshold ? this.speedBoostMultiplier : 1.0;
  }
}
