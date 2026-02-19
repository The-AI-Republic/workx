import type { ResponseEvent } from './types/ResponsesAPI';
import { t } from '@/extension/sidepanel/lib/i18n';

/**
 * SSE event structure
 * @interface SseEvent
 * @description Server-Sent Event structure
 */
interface SseEvent {
  /** Event type identifier (e.g., "response.output_text.delta") */
  type: string;
  /** Response object containing ID and metadata */
  response?: any;
  /** Item object for output items */
  item?: any;
  /** Text delta for streaming content */
  delta?: string;
}

/**
 * Error structure for parsing retry-after information
 * @interface ApiError
 * @description API error response structure with rate limiting information
 */
interface ApiError {
  /** Error type */
  type?: string;
  /** Human-readable error message */
  message?: string;
  /** Error code (e.g., "rate_limit_exceeded") */
  code?: string;
  /** Plan type for subscription errors */
  plan_type?: string;
  /** Time in seconds until rate limit resets */
  resets_in_seconds?: number;
}

/**
 * Memory pool for reusing event objects to reduce garbage collection pressure
 * @class EventPool
 * @description Implements object pooling pattern for SseEvent objects
 */
class EventPool {
  private eventPool: SseEvent[] = [];
  /** Maximum pool size to prevent memory leaks */
  private maxPoolSize = 50;

  /**
   * Get an event object from the pool or create a new one
   * @returns {SseEvent} Reusable event object
   */
  getEvent(): SseEvent {
    return this.eventPool.pop() || { type: '' };
  }

  /**
   * Return an event object to the pool for reuse
   * @param {SseEvent} event - Event object to return to pool
   */
  releaseEvent(event: SseEvent): void {
    if (this.eventPool.length < this.maxPoolSize) {
      // Clear properties for reuse
      event.type = '';
      event.response = undefined;
      event.item = undefined;
      event.delta = undefined;
      this.eventPool.push(event);
    }
  }
}

/**
 * Cache for frequently accessed event type mappings to optimize hot paths
 * @const {Map<string, boolean>} EVENT_TYPE_CACHE
 * @description Maps event types to handling status (true = process, false = ignore)
 */
const EVENT_TYPE_CACHE = new Map<string, boolean>([
  ['response.output_text.delta', true],
  ['response.reasoning_text.delta', true],
  ['response.reasoning_summary_text.delta', true],
  ['response.output_item.done', true],
  ['response.created', true],
  ['response.completed', true],
  ['response.output_item.added', true],
  ['response.reasoning_summary_part.added', true],
  ['response.failed', true],
  // Ignored events
  ['response.content_part.added', false],
  ['response.content_part.done', false],
  ['response.function_call_arguments.delta', false],
  ['response.function_call_arguments.done', false],
  ['response.custom_tool_call_input.delta', false],
  ['response.custom_tool_call_input.done', false],
  ['response.in_progress', false],
  ['response.output_text.done', false],
  ['response.reasoning_summary_text.done', false],
]);

/**
 * High-performance SSE Event Parser
 *
 * This class parses Server-Sent Events from the OpenAI Responses API and converts
 * them to ResponseEvent objects. The implementation handles all 11 event type mappings.
 *
 * **Event Mappings** (11 total):
 * 1. `response.created` → `{ type: 'Created' }`
 * 2. `response.output_item.done` → `{ type: 'OutputItemDone', item }`
 * 3. `response.output_text.delta` → `{ type: 'OutputTextDelta', delta }`
 * 4. `response.reasoning_summary_text.delta` → `{ type: 'ReasoningSummaryDelta', delta }`
 * 5. `response.reasoning_text.delta` → `{ type: 'ReasoningContentDelta', delta }`
 * 6. `response.reasoning_summary_part.added` → `{ type: 'ReasoningSummaryPartAdded' }`
 * 7. `response.output_item.added` (web_search) → `{ type: 'WebSearchCallBegin', callId }`
 * 8. `response.completed` → Store for yielding at stream end
 * 9. `response.failed` → Throw error immediately
 * 10. Ignored events → Return empty array
 * 11. Unknown events → Log debug, return empty array
 *
 * **Performance Optimization**:
 * - Memory pooling for event objects (reduces GC pressure)
 * - Event type caching (hot path optimization)
 * - Performance metrics tracking (<10ms per event target)
 * - Batch processing capability
 *
 * **Error Handling**:
 * - Parse errors don't fail stream (return null)
 * - `response.failed` throws Error
 * - Invalid JSON is logged but doesn't throw
 *
 * @example
 * ```typescript
 * const parser = new SSEEventParser();
 * const sseData = '{"type":"response.output_text.delta","delta":"Hello"}';
 * const event = parser.parse(sseData);
 * if (event) {
 *   const responseEvents = parser.processEvent(event);
 *   // responseEvents: [{ type: 'OutputTextDelta', delta: 'Hello' }]
 * }
 *
 * // Monitor performance
 * const metrics = parser.getPerformanceMetrics();
 * console.log(`Average: ${metrics.averageTime}ms per event`);
 * ```
 */
export class SSEEventParser {
  /** Regex pattern for parsing retry-after duration from error messages */
  private static readonly RETRY_AFTER_REGEX = /Please try again in (\d+(?:\.\d+)?)(s|ms)/;

  /** Memory pool for reusing event objects */
  private eventPool = new EventPool();

  /** Performance tracking metrics */
  private performanceMetrics = {
    /** Total number of events processed */
    totalProcessed: 0,
    /** Total processing time in milliseconds */
    totalTime: 0,
    /** Average processing time per event */
    averageTime: 0,
  };

  /**
   * Parse raw SSE text data into structured events with performance optimization
   * @param data Raw SSE data string
   * @returns Parsed SSE event or null if malformed
   */
  public parse(data: string): SseEvent | null {
    const startTime = performance.now();

    // Fast path for empty data
    if (!data || data.length === 0) {
      return null;
    }

    // Trim only if needed (avoid unnecessary string operations)
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return null;
    }

    try {
      // Use pooled object for better memory management
      const event = this.eventPool.getEvent();
      const parsed = JSON.parse(trimmed);

      // Copy properties instead of creating new object
      event.type = parsed.type || '';
      event.response = parsed.response;
      event.item = parsed.item;
      event.delta = parsed.delta;

      this.updatePerformanceMetrics(startTime);
      return event;
    } catch (error) {
      console.debug('Failed to parse SSE event:', error, 'data:', trimmed.substring(0, 100));
      this.updatePerformanceMetrics(startTime);
      return null;
    }
  }

  /**
   * Process a parsed SSE event and convert to ResponseEvent
   * @param event Parsed SSE event
   * @returns ResponseEvent array (can be multiple events for some types)
   */
  public processEvent(event: SseEvent): ResponseEvent[] {
    const startTime = performance.now();

    // Fast path: Check if event type should be ignored
    const isHandled = EVENT_TYPE_CACHE.get(event.type);
    if (isHandled === false) {
      // Event is explicitly ignored
      this.releaseEvent(event);
      return [];
    }

    const events: ResponseEvent[] = [];

    switch (event.type) {
      // Individual output item finalised - forward immediately for streaming
      case 'response.output_item.done':
        if (event.item) {
          try {
            events.push({
              type: 'OutputItemDone',
              item: event.item
            });
          } catch (error) {
            console.debug('Failed to parse ResponseItem from output_item.done');
          }
        }
        break;

      // Text delta events for streaming content
      case 'response.output_text.delta':
        if (event.delta) {
          events.push({
            type: 'OutputTextDelta',
            delta: event.delta
          });
        }
        break;

      case 'response.reasoning_summary_text.delta':
        if (event.delta) {
          events.push({
            type: 'ReasoningSummaryDelta',
            delta: event.delta
          });
        }
        break;

      case 'response.reasoning_text.delta':
        if (event.delta) {
          events.push({
            type: 'ReasoningContentDelta',
            delta: event.delta
          });
        }
        break;

      // Response lifecycle events
      case 'response.created':
        if (event.response) {
          events.push({
            type: 'Created'
          });
        }
        break;

      case 'response.failed':
        // Contract: response.failed must throw error
        if (event.response) {
          const error = event.response.error;
          let retryAfter: number | undefined;
          let message = t('Response failed');

          if (error) {
            const parsedError = error as ApiError;
            retryAfter = this.parseRetryAfter(parsedError);
            message = parsedError.message || message;
          }

          // Release event before throwing
          this.releaseEvent(event);

          // Throw error
          throw new Error(message);
        }
        break;

      case 'response.completed':
        if (event.response) {
          // Extract output items from response (for Groq and other providers that include output array)
          // Some providers (like Groq) include reasoning items in response.output array
          if (event.response.output && Array.isArray(event.response.output)) {
            for (const outputItem of event.response.output) {
              // Emit OutputItemDone events for each item in the output array
              if (outputItem && outputItem.type) {
                events.push({
                  type: 'OutputItemDone',
                  item: outputItem
                });
              }
            }
          }

          // Emit the Completed event
          events.push({
            type: 'Completed',
            responseId: event.response.id || '',
            tokenUsage: event.response.usage
          });
        }
        break;

      // Output item added - detect web search calls
      case 'response.output_item.added':
        if (event.item) {
          // Detect web_search_call begin and forward synthetic event
          if (event.item.type === 'web_search_call') {
            const callId = event.item.id || '';
            events.push({
              type: 'WebSearchCallBegin',
              callId: callId
            });
          }
        }
        break;

      // Reasoning summary part boundary
      case 'response.reasoning_summary_part.added':
        events.push({
          type: 'ReasoningSummaryPartAdded'
        });
        break;

      // Events we currently ignore
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done':
      case 'response.custom_tool_call_input.delta':
      case 'response.custom_tool_call_input.done':
      case 'response.in_progress':
      case 'response.output_text.done':
      case 'response.reasoning_summary_text.done':
        // Explicitly ignored
        break;

      default:
        // Unknown event type - log but don't error
        console.debug('Unknown SSE event type:', event.type);
        break;
    }

    // Release event back to pool and update metrics
    this.releaseEvent(event);
    this.updatePerformanceMetrics(startTime);
    return events;
  }

  /**
   * Parse retry-after duration from error message
   * @param error API error object
   * @returns Retry delay in milliseconds, or undefined if not found
   */
  public parseRetryAfter(error: ApiError): number | undefined {
    if (error.code !== 'rate_limit_exceeded' || !error.message) {
      return undefined;
    }

    const matches = SSEEventParser.RETRY_AFTER_REGEX.exec(error.message);
    if (!matches) {
      return undefined;
    }

    const value = parseFloat(matches[1]);
    const unit = matches[2];

    if (unit === 's') {
      return value * 1000; // Convert seconds to milliseconds
    } else if (unit === 'ms') {
      return value;
    }

    return undefined;
  }

  /**
   * Handle malformed SSE events with error recovery
   * @param rawData Raw SSE data that failed to parse
   * @returns Error event or null if recovery not possible
   */
  public handleMalformedEvent(rawData: string): null {
    console.warn('Malformed SSE event received:', rawData);

    // Try to extract any useful information from malformed data
    // This could include partial JSON parsing or pattern matching
    // For now, just log the error since ParseError is not in the ResponseEvent union
    // This would need to be added to the ResponseEvent type or handled differently
    console.error('Malformed SSE event', {
      error: 'Malformed SSE event',
      rawData: rawData.substring(0, 200) // Limit for debugging
    });

    return null;
  }

  /**
   * Release event back to pool for memory reuse
   */
  private releaseEvent(event: SseEvent): void {
    this.eventPool.releaseEvent(event);
  }

  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(startTime: number): void {
    const processingTime = performance.now() - startTime;
    this.performanceMetrics.totalProcessed++;
    this.performanceMetrics.totalTime += processingTime;
    this.performanceMetrics.averageTime =
      this.performanceMetrics.totalTime / this.performanceMetrics.totalProcessed;

    // Warn if processing takes longer than target (10ms)
    if (processingTime > 10) {
      console.warn(`SSE event processing took ${processingTime.toFixed(2)}ms (> 10ms target)`);
    }
  }

  /**
   * Get performance metrics for monitoring
   */
  public getPerformanceMetrics(): {
    totalProcessed: number;
    averageTime: number;
    isWithinTarget: boolean;
  } {
    return {
      totalProcessed: this.performanceMetrics.totalProcessed,
      averageTime: this.performanceMetrics.averageTime,
      isWithinTarget: this.performanceMetrics.averageTime < 10,
    };
  }

  /**
   * Reset performance metrics
   */
  public resetPerformanceMetrics(): void {
    this.performanceMetrics = {
      totalProcessed: 0,
      totalTime: 0,
      averageTime: 0,
    };
  }

  /**
   * Batch process multiple SSE data strings for better performance
   */
  public processBatch(dataArray: string[]): ResponseEvent[] {
    const allEvents: ResponseEvent[] = [];

    for (const data of dataArray) {
      const parsed = this.parse(data);
      if (parsed) {
        const events = this.processEvent(parsed);
        allEvents.push(...events);
      }
    }

    return allEvents;
  }
}