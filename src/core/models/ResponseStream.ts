import type { ResponseEvent } from './types/ResponseEvent';

/**
 * Configuration for ResponseStream behavior
 */
export interface ResponseStreamConfig {
  /** Maximum number of events to buffer */
  maxBufferSize: number;
  /** Timeout for waiting for new events (in milliseconds) */
  eventTimeout: number;
  /** Whether to enable backpressure handling */
  enableBackpressure: boolean;
}

/**
 * Error thrown when stream operations fail
 */
export class ResponseStreamError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ResponseStreamError';
  }
}

/**
 * Async iterable stream of ResponseEvent objects
 *
 * This class implements a producer-consumer pattern using an event buffer and async iteration.
 * Events are added by the producer (API response handler) and consumed via async iteration.
 *
 * **Pattern**:
 * - Producer: Calls `addEvent()` to send events
 * - Consumer: Uses `for await` to receive events
 * - Completion: Calls `complete()` to signal end of stream
 * - Error: Calls `error()` to signal error state
 *
 * **Features**:
 * - Buffering: Events are queued until consumed
 * - Backpressure: Optional buffer size limit throws when exceeded
 * - Timeout: Configurable idle timeout for event arrival
 * - Abort: Cancellation via AbortSignal
 *
 * @example
 * ```typescript
 * // Producer
 * const stream = new ResponseStream();
 * setTimeout(() => {
 *   stream.addEvent({ type: 'Created' });
 *   stream.addEvent({ type: 'OutputTextDelta', delta: 'Hello' });
 *   stream.complete();
 * }, 0);
 *
 * // Consumer
 * for await (const event of stream) {
 *   console.log(event);
 * }
 * ```
 */
export class ResponseStream {
  private eventBuffer: ResponseEvent[] = [];
  private isCompleted = false;
  private streamError: Error | null = null;  // Renamed from 'error' to avoid conflict with error() method
  private waitingResolvers: Array<() => void> = [];
  private abortController: AbortController;
  private config: ResponseStreamConfig;

  constructor(
    abortSignal?: AbortSignal,
    config: Partial<ResponseStreamConfig> = {}
  ) {
    this.config = {
      maxBufferSize: 1000,
      eventTimeout: 60000, // 60 seconds
      enableBackpressure: true,
      ...config
    };

    this.abortController = new AbortController();

    // Chain external abort signal
    if (abortSignal) {
      if (abortSignal.aborted) {
        this.abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => {
          this.abortController.abort();
        });
      }
    }
  }

  /**
   * Add a new event to the stream
   * @param event The event to add
   * @throws ResponseStreamError if stream is completed or buffer is full
   */
  public addEvent(event: ResponseEvent): void {
    if (this.isCompleted) {
      throw new ResponseStreamError('Cannot add event to completed stream');
    }

    if (this.abortController.signal.aborted) {
      throw new ResponseStreamError('Cannot add event to aborted stream');
    }

    // Check for backpressure
    if (this.config.enableBackpressure && this.eventBuffer.length >= this.config.maxBufferSize) {
      throw new ResponseStreamError(
        `Event buffer full (${this.config.maxBufferSize} events) - backpressure limit reached`,
        'BACKPRESSURE'
      );
    }

    this.eventBuffer.push(event);
    this.notifyWaiters();
  }

  /**
   * Add multiple events to the stream
   * @param events Array of events to add
   */
  public addEvents(events: ResponseEvent[]): void {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  /**
   * Complete the stream, indicating no more events will be added
   */
  public complete(): void {
    this.isCompleted = true;
    this.notifyWaiters();
  }

  /**
   * Error the stream, causing all future reads to throw
   * @param err The error that occurred
   */
  public error(err: Error): void {
    this.streamError = err;
    this.isCompleted = true;
    this.notifyWaiters();
  }

  /**
   * Abort the stream, cancelling any pending operations
   */
  public abort(): void {
    this.abortController.abort();
    this.notifyWaiters();
  }

  /**
   * Get the current buffer size
   */
  public getBufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Check if the stream is completed
   */
  public isStreamCompleted(): boolean {
    return this.isCompleted;
  }

  /**
   * Check if the stream was aborted
   */
  public isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Async iterator implementation
   */
  public async *[Symbol.asyncIterator](): AsyncIterableIterator<ResponseEvent> {
    try {
      while (true) {
        // Check for abort signal
        if (this.abortController.signal.aborted) {
          throw new ResponseStreamError('Stream aborted', 'ABORTED');
        }

        // If there's an error, throw it
        if (this.streamError) {
          throw new ResponseStreamError('Stream error', 'STREAM_ERROR', this.streamError);
        }

        // If we have buffered events, yield them
        if (this.eventBuffer.length > 0) {
          const event = this.eventBuffer.shift()!;
          yield event;
          continue;
        }

        // If stream is completed and buffer is empty, we're done
        if (this.isCompleted) {
          return;
        }

        // Wait for new events
        await this.waitForEvent();
      }
    } catch (error) {
      // Convert any errors to ResponseStreamError
      if (error instanceof ResponseStreamError) {
        throw error;
      }
      throw new ResponseStreamError('Iteration error', 'ITERATION_ERROR', error as Error);
    }
  }

  /**
   * Wait for a new event to be available
   */
  private async waitForEvent(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.removeWaitingResolver(resolve);
        reject(new ResponseStreamError(
          `Event timeout after ${this.config.eventTimeout}ms`,
          'TIMEOUT'
        ));
      }, this.config.eventTimeout);

      // Set up abort handling
      const abortHandler = () => {
        clearTimeout(timeout);
        this.removeWaitingResolver(resolve);
        reject(new ResponseStreamError('Stream aborted', 'ABORTED'));
      };

      if (this.abortController.signal.aborted) {
        clearTimeout(timeout);
        reject(new ResponseStreamError('Stream aborted', 'ABORTED'));
        return;
      }

      this.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      // Wrap resolver to clean up timeout and abort handler
      const wrappedResolve = () => {
        clearTimeout(timeout);
        this.abortController.signal.removeEventListener('abort', abortHandler);
        this.removeWaitingResolver(wrappedResolve);
        resolve();
      };

      this.waitingResolvers.push(wrappedResolve);

      // Check if we should resolve immediately
      if (this.eventBuffer.length > 0 || this.isCompleted || this.streamError) {
        wrappedResolve();
      }
    });
  }

  /**
   * Notify all waiting resolvers that new data is available
   */
  private notifyWaiters(): void {
    const resolvers = [...this.waitingResolvers];
    this.waitingResolvers = [];

    for (const resolver of resolvers) {
      try {
        resolver();
      } catch (error) {
        console.error('Error notifying waiter:', error);
      }
    }
  }

  /**
   * Remove a specific resolver from the waiting list
   */
  private removeWaitingResolver(resolver: () => void): void {
    const index = this.waitingResolvers.indexOf(resolver);
    if (index !== -1) {
      this.waitingResolvers.splice(index, 1);
    }
  }

  /**
   * Create a new ResponseStream from an array of events (for testing)
   */
  public static fromEvents(events: ResponseEvent[]): ResponseStream {
    const stream = new ResponseStream();

    // Add events asynchronously to simulate real streaming
    setTimeout(() => {
      try {
        for (const event of events) {
          stream.addEvent(event);
        }
        stream.complete();
      } catch (error) {
        stream.error(error as Error);
      }
    }, 0);

    return stream;
  }

  /**
   * Create a new ResponseStream that will error immediately (for testing)
   */
  public static fromError(error: Error): ResponseStream {
    const stream = new ResponseStream();
    setTimeout(() => stream.error(error), 0);
    return stream;
  }

  /**
   * Convert the stream to an array (collects all events)
   * WARNING: This will wait for the stream to complete
   */
  public async toArray(): Promise<ResponseEvent[]> {
    const events: ResponseEvent[] = [];

    try {
      for await (const event of this) {
        events.push(event);
      }
    } catch (error) {
      throw new ResponseStreamError('Failed to collect stream events', 'COLLECTION_ERROR', error as Error);
    }

    return events;
  }

  /**
   * Take only the first N events from the stream
   */
  public async *take(count: number): AsyncGenerator<ResponseEvent> {
    let taken = 0;

    for await (const event of this) {
      if (taken >= count) {
        break;
      }
      yield event;
      taken++;
    }
  }

  /**
   * Filter events based on a predicate function
   */
  public async *filter(predicate: (event: ResponseEvent) => boolean): AsyncGenerator<ResponseEvent> {
    for await (const event of this) {
      if (predicate(event)) {
        yield event;
      }
    }
  }

  /**
   * Transform events using a mapping function
   */
  public async *map<T>(mapper: (event: ResponseEvent) => T): AsyncGenerator<T> {
    for await (const event of this) {
      yield mapper(event);
    }
  }
}