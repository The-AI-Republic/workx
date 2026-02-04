/**
 * Request Queue with priority support and persistence
 *
 * @fileoverview Implements a FIFO queue with priority lanes and rate limiting
 * for managing AI model requests in the Chrome extension environment.
 * Features persistence across extension restarts and comprehensive analytics.
 */

import { CompletionRequest } from './ModelClient';

/**
 * Represents a queued request with metadata and callbacks
 *
 * @interface QueuedRequest
 * @description Contains all information needed to process and track a request
 */
export interface QueuedRequest {
  /** Unique identifier for the request */
  id: string;
  /** The completion request to be processed */
  request: CompletionRequest;
  /** Priority level for queue ordering */
  priority: RequestPriority;
  /** Timestamp when request was queued */
  timestamp: number;
  /** Number of retry attempts made */
  retryCount: number;
  /** Maximum number of retries allowed */
  maxRetries: number;
  /** Callback for successful completion */
  onComplete?: (response: any) => void;
  /** Callback for error handling */
  onError?: (error: Error) => void;
}

/**
 * Priority levels for request queue ordering
 *
 * @enum {number} RequestPriority
 * @description Higher numeric values indicate higher priority
 */
export enum RequestPriority {
  /** Low priority requests (background tasks) */
  LOW = 0,
  /** Normal priority requests (default) */
  NORMAL = 1,
  /** High priority requests (user interactions) */
  HIGH = 2,
  /** Urgent priority requests (critical operations) */
  URGENT = 3,
}

/**
 * Configuration for rate limiting behavior
 *
 * @interface RateLimitConfig
 * @description Defines limits for API request frequency
 */
export interface RateLimitConfig {
  /** Maximum requests allowed per minute */
  requestsPerMinute: number;
  /** Maximum requests allowed per hour */
  requestsPerHour: number;
  /** Maximum burst requests allowed */
  burstLimit: number;
}

/**
 * Queue performance and status metrics
 *
 * @interface QueueMetrics
 * @description Comprehensive metrics for monitoring queue health
 */
export interface QueueMetrics {
  /** Total number of requests queued since creation */
  totalQueued: number;
  /** Total number of requests successfully processed */
  totalProcessed: number;
  /** Total number of requests that failed permanently */
  totalErrors: number;
  /** Current number of requests in queue */
  currentQueueSize: number;
  /** Average processing time per request in milliseconds */
  averageProcessingTime: number;
  /** Number of requests in queue by priority level */
  queueSizeByPriority: Record<RequestPriority, number>;
}

/**
 * Persistent request queue with priority support and rate limiting
 *
 * @class RequestQueue
 * @description High-performance request queue that manages AI model requests with:
 * - Priority-based FIFO ordering (Urgent > High > Normal > Low)
 * - Rate limiting to prevent API quota violations
 * - Persistence across Chrome extension restarts
 * - Exponential backoff retry logic
 * - Comprehensive analytics and monitoring
 *
 * @example
 * ```typescript
 * const queue = new RequestQueue({
 *   requestsPerMinute: 60,
 *   requestsPerHour: 1000,
 *   burstLimit: 10
 * });
 *
 * const requestId = queue.enqueue(completionRequest, RequestPriority.HIGH, {
 *   maxRetries: 3,
 *   onComplete: (response) => console.log('Success:', response),
 *   onError: (error) => console.error('Failed:', error)
 * });
 *
 * const status = queue.getStatus();
 * console.log(`Queue size: ${status.queueSize}, Processing: ${status.processing}`);
 * ```
 */
export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private rateLimitConfig: RateLimitConfig;
  private requestHistory: Array<{ timestamp: number; success: boolean; duration: number }> = [];
  private metrics: QueueMetrics = {
    totalQueued: 0,
    totalProcessed: 0,
    totalErrors: 0,
    currentQueueSize: 0,
    averageProcessingTime: 0,
    queueSizeByPriority: {
      [RequestPriority.LOW]: 0,
      [RequestPriority.NORMAL]: 0,
      [RequestPriority.HIGH]: 0,
      [RequestPriority.URGENT]: 0,
    },
  };

  private readonly STORAGE_KEY = 'browserx_request_queue';
  private readonly HISTORY_KEY = 'browserx_request_history';
  private readonly MAX_HISTORY_SIZE = 1000;

  /**
   * Creates a new RequestQueue with the specified rate limiting configuration
   *
   * @param {RateLimitConfig} rateLimitConfig - Rate limiting configuration
   * @param {number} rateLimitConfig.requestsPerMinute - Requests per minute limit (default: 60)
   * @param {number} rateLimitConfig.requestsPerHour - Requests per hour limit (default: 1000)
   * @param {number} rateLimitConfig.burstLimit - Burst request limit (default: 10)
   */
  constructor(rateLimitConfig: RateLimitConfig = {
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    burstLimit: 10,
  }) {
    this.rateLimitConfig = rateLimitConfig;
    this.loadFromStorage();
  }

  /**
   * Add request to queue with specified priority
   *
   * @param {CompletionRequest} request - The completion request to queue
   * @param {RequestPriority} priority - Priority level (default: NORMAL)
   * @param {object} options - Additional options for the request
   * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
   * @param {Function} options.onComplete - Success callback
   * @param {Function} options.onError - Error callback
   * @returns {string} Unique request ID for tracking
   *
   * @example
   * ```typescript
   * const requestId = queue.enqueue(
   *   { model: 'gpt-4', messages: [...] },
   *   RequestPriority.HIGH,
   *   {
   *     maxRetries: 5,
   *     onComplete: (response) => console.log('Done:', response),
   *     onError: (error) => console.error('Error:', error)
   *   }
   * );
   * ```
   */
  public enqueue(
    request: CompletionRequest,
    priority: RequestPriority = RequestPriority.NORMAL,
    options: {
      maxRetries?: number;
      onComplete?: (response: any) => void;
      onError?: (error: Error) => void;
    } = {}
  ): string {
    const queuedRequest: QueuedRequest = {
      id: this.generateRequestId(),
      request,
      priority,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: options.maxRetries || 3,
      onComplete: options.onComplete,
      onError: options.onError,
    };

    // Insert request in priority order
    this.insertByPriority(queuedRequest);

    this.metrics.totalQueued++;
    this.metrics.currentQueueSize++;
    this.metrics.queueSizeByPriority[priority]++;

    this.persistToStorage();

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return queuedRequest.id;
  }

  /**
   * Remove request from queue by ID
   */
  public dequeue(requestId: string): boolean {
    const index = this.queue.findIndex(req => req.id === requestId);
    if (index === -1) {
      return false;
    }

    const removed = this.queue.splice(index, 1)[0];
    this.metrics.currentQueueSize--;
    this.metrics.queueSizeByPriority[removed.priority]--;

    this.persistToStorage();
    return true;
  }

  /**
   * Get current queue status
   */
  public getStatus(): {
    queueSize: number;
    processing: boolean;
    nextRequest?: QueuedRequest;
    metrics: QueueMetrics;
  } {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      nextRequest: this.queue[0],
      metrics: { ...this.metrics },
    };
  }

  /**
   * Clear all requests from queue
   */
  public clear(): void {
    this.queue = [];
    this.metrics.currentQueueSize = 0;
    this.metrics.queueSizeByPriority = {
      [RequestPriority.LOW]: 0,
      [RequestPriority.NORMAL]: 0,
      [RequestPriority.HIGH]: 0,
      [RequestPriority.URGENT]: 0,
    };
    this.persistToStorage();
  }

  /**
   * Pause queue processing
   */
  public pause(): void {
    this.processing = false;
  }

  /**
   * Resume queue processing
   */
  public resume(): void {
    if (!this.processing && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Process queue with rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Check rate limits
        if (!this.canMakeRequest()) {
          const delay = this.getDelayUntilNextRequest();
          await this.sleep(delay);
          continue;
        }

        const request = this.queue.shift();
        if (!request) {
          break;
        }

        this.metrics.currentQueueSize--;
        this.metrics.queueSizeByPriority[request.priority]--;

        const startTime = Date.now();
        let success = false;

        try {
          // Here we would make the actual request
          // For now, this is a placeholder for the actual implementation
          await this.executeRequest(request);

          success = true;
          this.metrics.totalProcessed++;

          if (request.onComplete) {
            request.onComplete(null); // Response would be passed here
          }
        } catch (error) {
          request.retryCount++;

          if (request.retryCount <= request.maxRetries) {
            // Re-queue for retry with exponential backoff
            request.timestamp = Date.now() + this.getRetryDelay(request.retryCount);
            this.insertByPriority(request);
            this.metrics.currentQueueSize++;
            this.metrics.queueSizeByPriority[request.priority]++;
          } else {
            this.metrics.totalErrors++;
            if (request.onError) {
              request.onError(error as Error);
            }
          }
        } finally {
          const duration = Date.now() - startTime;
          this.recordRequest(success, duration);
          this.updateAverageProcessingTime();
        }

        // Small delay between requests to be respectful
        await this.sleep(100);
      }
    } finally {
      this.processing = false;
      this.persistToStorage();
    }
  }

  /**
   * Execute a single request (placeholder for actual implementation)
   */
  private async executeRequest(request: QueuedRequest): Promise<any> {
    // This would be implemented by the actual model client
    // For now, just simulate processing time
    await this.sleep(500 + Math.random() * 1000);

    // Simulate occasional failures for testing retry logic
    if (Math.random() < 0.1) {
      throw new Error('Simulated request failure');
    }

    return { success: true };
  }

  /**
   * Insert request maintaining priority order
   */
  private insertByPriority(request: QueuedRequest): void {
    let inserted = false;

    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < request.priority ||
          (this.queue[i].priority === request.priority && this.queue[i].timestamp > request.timestamp)) {
        this.queue.splice(i, 0, request);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.queue.push(request);
    }
  }

  /**
   * Check if we can make a request based on rate limits
   */
  private canMakeRequest(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentRequests = this.requestHistory.filter(r => r.timestamp > oneMinuteAgo);
    const hourlyRequests = this.requestHistory.filter(r => r.timestamp > oneHourAgo);

    // Check burst limit
    if (recentRequests.length >= this.rateLimitConfig.burstLimit) {
      return false;
    }

    // Check per-minute limit
    if (recentRequests.length >= this.rateLimitConfig.requestsPerMinute) {
      return false;
    }

    // Check per-hour limit
    if (hourlyRequests.length >= this.rateLimitConfig.requestsPerHour) {
      return false;
    }

    return true;
  }

  /**
   * Get delay in milliseconds until next request can be made
   */
  private getDelayUntilNextRequest(): number {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const recentRequests = this.requestHistory
      .filter(r => r.timestamp > oneMinuteAgo)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (recentRequests.length >= this.rateLimitConfig.requestsPerMinute) {
      // Wait until the oldest request in the window expires
      return recentRequests[0].timestamp + 60 * 1000 - now;
    }

    return 1000; // Default 1 second delay
  }

  /**
   * Get retry delay with exponential backoff
   */
  private getRetryDelay(retryCount: number): number {
    return Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30 seconds
  }

  /**
   * Record request in history for rate limiting
   */
  private recordRequest(success: boolean, duration: number): void {
    this.requestHistory.push({
      timestamp: Date.now(),
      success,
      duration,
    });

    // Trim history to prevent memory leaks
    if (this.requestHistory.length > this.MAX_HISTORY_SIZE) {
      this.requestHistory = this.requestHistory.slice(-this.MAX_HISTORY_SIZE);
    }

    this.persistHistory();
  }

  /**
   * Update average processing time metric
   */
  private updateAverageProcessingTime(): void {
    const recentHistory = this.requestHistory.slice(-100); // Last 100 requests
    if (recentHistory.length === 0) return;

    const totalTime = recentHistory.reduce((sum, record) => sum + record.duration, 0);
    this.metrics.averageProcessingTime = totalTime / recentHistory.length;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Load queue from Chrome storage
   */
  private async loadFromStorage(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([this.STORAGE_KEY, this.HISTORY_KEY]);

      if (result[this.STORAGE_KEY]) {
        const saved = JSON.parse(result[this.STORAGE_KEY]);
        this.queue = saved.queue || [];
        this.metrics = { ...this.metrics, ...saved.metrics };
      }

      if (result[this.HISTORY_KEY]) {
        this.requestHistory = JSON.parse(result[this.HISTORY_KEY]) || [];
      }

      // Clean up old requests (older than 1 hour)
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      this.queue = this.queue.filter(req => req.timestamp > oneHourAgo);
      this.requestHistory = this.requestHistory.filter(r => r.timestamp > oneHourAgo);

      // Recalculate metrics after cleanup
      this.recalculateMetrics();

      console.log(`Loaded ${this.queue.length} queued requests from storage`);
    } catch (error) {
      console.warn('Failed to load request queue from storage:', error);
    }
  }

  /**
   * Persist queue to Chrome storage
   */
  private async persistToStorage(): Promise<void> {
    try {
      const data = {
        queue: this.queue,
        metrics: this.metrics,
        timestamp: Date.now(),
      };

      await chrome.storage.local.set({
        [this.STORAGE_KEY]: JSON.stringify(data),
      });
    } catch (error) {
      console.warn('Failed to persist request queue to storage:', error);
    }
  }

  /**
   * Persist request history to Chrome storage
   */
  private async persistHistory(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [this.HISTORY_KEY]: JSON.stringify(this.requestHistory),
      });
    } catch (error) {
      console.warn('Failed to persist request history to storage:', error);
    }
  }

  /**
   * Recalculate metrics from current queue state
   */
  private recalculateMetrics(): void {
    this.metrics.currentQueueSize = this.queue.length;
    this.metrics.queueSizeByPriority = {
      [RequestPriority.LOW]: 0,
      [RequestPriority.NORMAL]: 0,
      [RequestPriority.HIGH]: 0,
      [RequestPriority.URGENT]: 0,
    };

    for (const request of this.queue) {
      this.metrics.queueSizeByPriority[request.priority]++;
    }
  }

  /**
   * Get detailed queue analytics
   */
  public getAnalytics(): {
    successRate: number;
    averageWaitTime: number;
    queueTrends: Array<{ timestamp: number; queueSize: number }>;
  } {
    const recentHistory = this.requestHistory.slice(-100);
    const successCount = recentHistory.filter(r => r.success).length;
    const successRate = recentHistory.length > 0 ? successCount / recentHistory.length : 0;

    const averageWaitTime = this.queue.length > 0
      ? this.queue.reduce((sum, req) => sum + (Date.now() - req.timestamp), 0) / this.queue.length
      : 0;

    // Generate simple trend data (this could be enhanced with more sophisticated tracking)
    const queueTrends = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() - (9 - i) * 60 * 1000,
      queueSize: this.queue.length, // This would need historical tracking for real trends
    }));

    return {
      successRate,
      averageWaitTime,
      queueTrends,
    };
  }
}