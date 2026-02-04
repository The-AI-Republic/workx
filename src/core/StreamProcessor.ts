/**
 * StreamProcessor - Handles streaming responses in browser context
 *
 * Manages chunked data efficiently, applies backpressure when needed,
 * and batches UI updates for optimal performance.
 *
 * Extended in Phase 6 to also handle ResponseEvents from OpenAIResponsesClient.
 */

import type { ResponseEvent } from './models/types/ResponseEvent';

/**
 * UI update types for progressive rendering
 */
export interface UIUpdate {
  id: string;
  type: 'append' | 'replace' | 'clear';
  target: 'message' | 'code' | 'status';
  content: string;
  metadata?: {
    tokens?: number;
    timestamp?: number;
    sequenceNumber?: number;
  };
}

/**
 * Stream chunk representation
 */
export interface StreamChunk {
  id: string;
  data: Uint8Array | string;
  timestamp: number;
  sequenceNumber: number;
  isFinal: boolean;
}

/**
 * Stream buffer for managing chunks
 */
export class StreamBuffer {
  private chunks: StreamChunk[] = [];
  private totalSize: number = 0;
  private maxSize: number;

  constructor(maxSize: number = 1024 * 1024) { // 1MB default
    this.maxSize = maxSize;
  }

  push(chunk: StreamChunk): boolean {
    const chunkSize = this.getChunkSize(chunk);

    if (this.totalSize + chunkSize > this.maxSize) {
      return false; // Buffer full
    }

    this.chunks.push(chunk);
    this.totalSize += chunkSize;
    return true;
  }

  shift(): StreamChunk | undefined {
    const chunk = this.chunks.shift();
    if (chunk) {
      this.totalSize -= this.getChunkSize(chunk);
    }
    return chunk;
  }

  clear(): void {
    this.chunks = [];
    this.totalSize = 0;
  }

  getSize(): number {
    return this.totalSize;
  }

  private getChunkSize(chunk: StreamChunk): number {
    if (typeof chunk.data === 'string') {
      return chunk.data.length;
    }
    return chunk.data.byteLength;
  }
}

/**
 * Stream processing status
 */
export type StreamStatus = 'idle' | 'streaming' | 'paused' | 'completed' | 'error';

/**
 * Stream configuration
 */
export interface StreamConfig {
  maxBufferSize?: number;      // Default: 1MB
  pauseThreshold?: number;      // Default: 0.8 * maxBufferSize
  resumeThreshold?: number;     // Default: 0.5 * maxBufferSize
  updateInterval?: number;      // Default: 100ms
  encoding?: 'utf-8' | 'binary'; // Default: 'utf-8'
  chunkSize?: number;          // Default: 16KB
}

/**
 * Stream metrics for monitoring
 */
export interface StreamMetrics {
  bytesProcessed: number;
  chunksProcessed: number;
  averageChunkSize: number;
  processingRate: number; // bytes/second
  bufferUtilization: number; // percentage
  updateCount: number;
  errorCount: number;
  startTime: number;
  endTime?: number;
}

/**
 * Main StreamProcessor class for handling browser streaming
 */
export class StreamProcessor {
  private buffer: StreamBuffer;
  private status: StreamStatus = 'idle';
  private reader: ReadableStreamDefaultReader | null = null;
  private updateCallbacks: ((update: UIUpdate) => void)[] = [];
  private responseEventCallbacks: ((event: ResponseEvent) => void)[] = [];
  private updateTimer: number | null = null;
  private pendingUpdates: UIUpdate[] = [];
  private config: Required<StreamConfig>;
  private metrics: StreamMetrics;
  private decoder: TextDecoder;
  private sequenceNumber: number = 0;
  private source: 'model' | 'tool' | 'network';

  constructor(source: 'model' | 'tool' | 'network', config?: StreamConfig) {
    this.source = source;
    this.config = {
      maxBufferSize: config?.maxBufferSize || 1024 * 1024, // 1MB
      pauseThreshold: config?.pauseThreshold || (config?.maxBufferSize || 1024 * 1024) * 0.8,
      resumeThreshold: config?.resumeThreshold || (config?.maxBufferSize || 1024 * 1024) * 0.5,
      updateInterval: config?.updateInterval || 100,
      encoding: config?.encoding || 'utf-8',
      chunkSize: config?.chunkSize || 16384, // 16KB
    };

    this.buffer = new StreamBuffer(this.config.maxBufferSize);
    this.decoder = new TextDecoder(this.config.encoding);

    this.metrics = {
      bytesProcessed: 0,
      chunksProcessed: 0,
      averageChunkSize: 0,
      processingRate: 0,
      bufferUtilization: 0,
      updateCount: 0,
      errorCount: 0,
      startTime: Date.now(),
    };
  }

  /**
   * Start processing a stream
   */
  async start(stream: ReadableStream): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'completed') {
      throw new Error('Stream already in progress');
    }

    this.reader = stream.getReader();
    this.status = 'streaming';
    this.metrics.startTime = Date.now();

    try {
      await this.processStream();
      this.status = 'completed';
      this.flushPendingUpdates();
    } catch (error) {
      this.status = 'error';
      this.metrics.errorCount++;
      throw error;
    } finally {
      if (this.reader) {
        this.reader.releaseLock();
        this.reader = null;
      }
      this.metrics.endTime = Date.now();
    }
  }

  /**
   * Process ResponseEvent stream from OpenAIResponsesClient
   * Integrates ResponseEvent emission alongside existing UIUpdate events
   */
  async processResponsesStream(
    responseStream: AsyncGenerator<ResponseEvent>
  ): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'completed') {
      throw new Error('Stream already in progress');
    }

    this.status = 'streaming';
    this.metrics.startTime = Date.now();

    try {
      for await (const responseEvent of responseStream) {
        // Emit ResponseEvent to callbacks
        this.responseEventCallbacks.forEach(callback => {
          try {
            callback(responseEvent);
          } catch (error) {
            console.error('ResponseEvent callback error:', error);
          }
        });

        // Convert ResponseEvent to UIUpdate when appropriate
        const uiUpdate = this.convertResponseEventToUIUpdate(responseEvent);
        if (uiUpdate) {
          this.batchUpdate(uiUpdate);
        }

        // Update metrics for ResponseEvents
        this.updateMetricsForResponseEvent(responseEvent);

        // Apply backpressure if needed
        if (this.shouldApplyBackpressure()) {
          this.pause();
          await this.waitForBuffer();
          this.resume();
        }
      }

      this.status = 'completed';
      this.flushPendingUpdates();
    } catch (error) {
      this.status = 'error';
      this.metrics.errorCount++;
      throw error;
    } finally {
      this.metrics.endTime = Date.now();
    }
  }

  /**
   * Main stream processing loop
   */
  private async processStream(): Promise<void> {
    if (!this.reader) return;

    while (true) {
      const { done, value } = await this.reader.read();

      if (done) break;

      await this.processChunk(value);

      if (this.shouldApplyBackpressure()) {
        this.pause();
        await this.waitForBuffer();
        this.resume();
      }
    }
  }

  /**
   * Process individual stream chunks
   */
  private async processChunk(value: Uint8Array | string): Promise<void> {
    const chunk: StreamChunk = {
      id: `chunk_${this.sequenceNumber}`,
      data: value,
      timestamp: Date.now(),
      sequenceNumber: this.sequenceNumber++,
      isFinal: false,
    };

    // Add to buffer
    if (!this.buffer.push(chunk)) {
      throw new Error('Buffer overflow');
    }

    // Update metrics
    const chunkSize = typeof value === 'string' ? value.length : value.byteLength;
    this.metrics.bytesProcessed += chunkSize;
    this.metrics.chunksProcessed++;
    this.metrics.averageChunkSize = this.metrics.bytesProcessed / this.metrics.chunksProcessed;
    this.metrics.bufferUtilization = (this.buffer.getSize() / this.config.maxBufferSize) * 100;

    // Decode if binary
    const text = typeof value === 'string' ? value : this.decoder.decode(value, { stream: true });

    // Create UI update
    const update: UIUpdate = {
      id: chunk.id,
      type: 'append',
      target: this.source === 'model' ? 'message' : 'status',
      content: text,
      metadata: {
        tokens: text.split(/\s+/).length,
        timestamp: chunk.timestamp,
        sequenceNumber: chunk.sequenceNumber,
      },
    };

    // Batch update
    this.batchUpdate(update);
  }

  /**
   * Batch UI updates for efficiency
   */
  private batchUpdate(update: UIUpdate): void {
    // Coalesce consecutive appends
    const lastUpdate = this.pendingUpdates[this.pendingUpdates.length - 1];

    if (lastUpdate?.type === 'append' &&
        update.type === 'append' &&
        lastUpdate.target === update.target) {
      lastUpdate.content += update.content;
      if (lastUpdate.metadata && update.metadata) {
        lastUpdate.metadata.tokens = (lastUpdate.metadata.tokens || 0) + (update.metadata.tokens || 0);
      }
    } else {
      this.pendingUpdates.push(update);
    }

    this.scheduleUIUpdate();
  }

  /**
   * Schedule UI updates at regular intervals
   */
  private scheduleUIUpdate(): void {
    if (this.updateTimer) return;

    // Use global setTimeout (works in both window and service worker contexts)
    this.updateTimer = setTimeout(() => {
      this.flushPendingUpdates();
      this.updateTimer = null;
    }, this.config.updateInterval);
  }

  /**
   * Flush all pending UI updates
   */
  flushPendingUpdates(): void {
    if (this.pendingUpdates.length === 0) return;

    const updates = [...this.pendingUpdates];
    this.pendingUpdates = [];

    this.updateCallbacks.forEach(callback => {
      updates.forEach(update => {
        callback(update);
        this.metrics.updateCount++;
      });
    });
  }

  /**
   * Check if backpressure should be applied
   */
  private shouldApplyBackpressure(): boolean {
    return this.buffer.getSize() > this.config.pauseThreshold ||
           this.pendingUpdates.length > 100;
  }

  /**
   * Wait for buffer to drain
   */
  private async waitForBuffer(): Promise<void> {
    while (this.buffer.getSize() > this.config.resumeThreshold) {
      await new Promise(resolve => setTimeout(resolve, 10));

      // Process some chunks from buffer if needed
      const chunk = this.buffer.shift();
      if (chunk) {
        // Process buffered chunk
        this.flushPendingUpdates();
      }
    }
  }

  /**
   * Pause stream processing
   */
  pause(): void {
    if (this.status === 'streaming') {
      this.status = 'paused';
    }
  }

  /**
   * Resume stream processing
   */
  resume(): void {
    if (this.status === 'paused') {
      this.status = 'streaming';
    }
  }

  /**
   * Abort stream processing
   */
  abort(): void {
    this.status = 'error';
    this.buffer.clear();
    this.pendingUpdates = [];

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.reader) {
      this.reader.cancel();
    }
  }

  /**
   * Convert ResponseEvent to UIUpdate when appropriate
   */
  private convertResponseEventToUIUpdate(event: ResponseEvent): UIUpdate | null {
    const updateId = `resp_${this.sequenceNumber++}`;
    const timestamp = Date.now();

    switch (event.type) {
      case 'OutputTextDelta':
        return {
          id: updateId,
          type: 'append',
          target: 'message',
          content: event.delta,
          metadata: {
            tokens: this.countApproximateTokens(event.delta),
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'ReasoningSummaryDelta':
        return {
          id: updateId,
          type: 'append',
          target: 'message',
          content: `[Reasoning] ${event.delta}`,
          metadata: {
            tokens: this.countApproximateTokens(event.delta),
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'ReasoningContentDelta':
        return {
          id: updateId,
          type: 'append',
          target: 'message',
          content: `[Thinking] ${event.delta}`,
          metadata: {
            tokens: this.countApproximateTokens(event.delta),
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'Created':
        return {
          id: updateId,
          type: 'replace',
          target: 'status',
          content: 'Response started...',
          metadata: {
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'Completed':
        return {
          id: updateId,
          type: 'replace',
          target: 'status',
          content: `Response completed. ID: ${event.responseId}${event.tokenUsage ? `, Tokens: ${event.tokenUsage.total_tokens}` : ''}`,
          metadata: {
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'WebSearchCallBegin':
        return {
          id: updateId,
          type: 'append',
          target: 'status',
          content: `Web search initiated (${event.callId})...`,
          metadata: {
            timestamp,
            sequenceNumber: this.sequenceNumber - 1,
          },
        };

      case 'OutputItemDone':
      case 'ReasoningSummaryPartAdded':
      case 'RateLimits':
        // These events don't directly translate to UI updates
        // but can be handled by ResponseEvent callbacks
        return null;

      default:
        return null;
    }
  }

  /**
   * Update metrics for ResponseEvent processing
   */
  private updateMetricsForResponseEvent(event: ResponseEvent): void {
    // Count text content for metrics
    let textContent = '';

    switch (event.type) {
      case 'OutputTextDelta':
      case 'ReasoningSummaryDelta':
      case 'ReasoningContentDelta':
        textContent = event.delta;
        break;
      default:
        // No text content to measure
        break;
    }

    if (textContent) {
      const textBytes = new TextEncoder().encode(textContent).length;
      this.metrics.bytesProcessed += textBytes;
      this.metrics.chunksProcessed++;
      this.metrics.averageChunkSize = this.metrics.bytesProcessed / this.metrics.chunksProcessed;
    }

    // Update buffer utilization based on pending updates
    this.metrics.bufferUtilization = (this.pendingUpdates.length / 100) * 100; // Assume max 100 pending updates
  }

  /**
   * Count approximate tokens in text for metrics
   */
  private countApproximateTokens(text: string): number {
    return text.split(/\s+/).length;
  }

  /**
   * Register callback for UI updates
   */
  onUpdate(callback: (update: UIUpdate) => void): void {
    this.updateCallbacks.push(callback);
  }

  /**
   * Register callback for ResponseEvents
   */
  onResponseEvent(callback: (event: ResponseEvent) => void): void {
    this.responseEventCallbacks.push(callback);
  }

  /**
   * Get current status
   */
  getStatus(): StreamStatus {
    return this.status;
  }

  /**
   * Get stream metrics
   */
  getMetrics(): StreamMetrics {
    const now = Date.now();
    const duration = (this.metrics.endTime || now) - this.metrics.startTime;

    return {
      ...this.metrics,
      processingRate: duration > 0 ? this.metrics.bytesProcessed / (duration / 1000) : 0,
    };
  }

  /**
   * Get buffer size
   */
  getBufferSize(): number {
    return this.buffer.getSize();
  }

  /**
   * Clear buffer
   */
  clearBuffer(): void {
    this.buffer.clear();
  }

  /**
   * Set max buffer size
   */
  setMaxBufferSize(size: number): void {
    this.config.maxBufferSize = size;
    this.config.pauseThreshold = size * 0.8;
    this.config.resumeThreshold = size * 0.5;
  }
}