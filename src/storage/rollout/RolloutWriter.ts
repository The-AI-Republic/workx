/**
 * Writer for RolloutRecorder
 * Handles async write operations with batching and sequence management.
 * Delegates all storage to the injected RolloutStorageProvider.
 */

import type { ConversationId, RolloutItem } from './types';
import type { RolloutStorageProvider } from './provider/RolloutStorageProvider';
import { formatTimestamp } from './helpers';

// ============================================================================
// RolloutWriter Class
// ============================================================================

/**
 * Manages async write operations for rollout data.
 * Batches writes for performance and maintains sequence numbers.
 */
export class RolloutWriter {
  private provider: RolloutStorageProvider;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentSequence: number;
  private rolloutId: ConversationId;
  private closed = false;

  private constructor(provider: RolloutStorageProvider, rolloutId: ConversationId, startSequence: number) {
    this.provider = provider;
    this.rolloutId = rolloutId;
    this.currentSequence = startSequence;
  }

  /**
   * Create a new RolloutWriter instance.
   * @param rolloutId - Conversation ID for this rollout
   * @param startSequence - Starting sequence number (default 0)
   * @param provider - Storage provider to use
   * @returns Promise resolving to RolloutWriter instance
   */
  static async create(rolloutId: ConversationId, startSequence = 0, provider: RolloutStorageProvider): Promise<RolloutWriter> {
    return new RolloutWriter(provider, rolloutId, startSequence);
  }

  /**
   * Add items to the write queue.
   * Items will be written via the provider.
   * @param rolloutId - Conversation ID
   * @param items - Array of rollout items to persist
   */
  async addItems(rolloutId: ConversationId, items: RolloutItem[]): Promise<void> {
    if (this.closed) return;

    if (items.length === 0) return;

    // Add write operation to the serialization queue
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.closed) return;

      const records = items.map((item) => ({
        timestamp: formatTimestamp(new Date()),
        sequence: this.currentSequence++,
        type: item.type,
        payload: item.payload,
      }));

      await this.provider.addItems(rolloutId, records);
    });

    return this.writeQueue;
  }

  /**
   * Wait for all pending writes to complete.
   */
  async flush(): Promise<void> {
    return this.writeQueue;
  }

  /**
   * Close the writer (provider is managed externally).
   */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  /**
   * Get the current sequence number.
   */
  getCurrentSequence(): number {
    return this.currentSequence;
  }
}
