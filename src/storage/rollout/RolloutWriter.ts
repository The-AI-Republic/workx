/**
 * IndexedDB writer for RolloutRecorder
 * Handles async write operations with batching and sequence management
 */

import {
  DB_NAME,
  DB_VERSION,
  STORE_ROLLOUTS,
  STORE_ROLLOUT_ITEMS,
  type ConversationId,
  type RolloutItem,
  type RolloutMetadataRecord,
} from './types';
import { formatTimestamp } from './helpers';

// ============================================================================
// RolloutWriter Class
// ============================================================================

/**
 * Manages async write operations to IndexedDB for rollout data.
 * Batches writes for performance and maintains sequence numbers.
 */
export class RolloutWriter {
  private db: IDBDatabase | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentSequence: number;
  private rolloutId: ConversationId;
  private closed = false;

  private constructor(db: IDBDatabase, rolloutId: ConversationId, startSequence: number) {
    this.db = db;
    this.rolloutId = rolloutId;
    this.currentSequence = startSequence;
  }

  /**
   * Create a new RolloutWriter instance.
   * @param rolloutId - Conversation ID for this rollout
   * @param startSequence - Starting sequence number (default 0)
   * @returns Promise resolving to RolloutWriter instance
   */
  static async create(rolloutId: ConversationId, startSequence = 0): Promise<RolloutWriter> {
    const db = await RolloutWriter.openDatabase();
    return new RolloutWriter(db, rolloutId, startSequence);
  }

  /**
   * Open or create the IndexedDB database.
   * @returns Promise resolving to IDBDatabase
   */
  private static openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create rollouts object store
        if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
          const rolloutsStore = db.createObjectStore(STORE_ROLLOUTS, { keyPath: 'id' });
          rolloutsStore.createIndex('created', 'created', { unique: false });
          rolloutsStore.createIndex('updated', 'updated', { unique: false });
          rolloutsStore.createIndex('expiresAt', 'expiresAt', { unique: false });
          rolloutsStore.createIndex('status', 'status', { unique: false });
        }

        // Create rollout_items object store
        if (!db.objectStoreNames.contains(STORE_ROLLOUT_ITEMS)) {
          const itemsStore = db.createObjectStore(STORE_ROLLOUT_ITEMS, {
            keyPath: 'id',
            autoIncrement: true,
          });
          itemsStore.createIndex('rolloutId', 'rolloutId', { unique: false });
          itemsStore.createIndex('timestamp', 'timestamp', { unique: false });
          itemsStore.createIndex('rolloutId_sequence', ['rolloutId', 'sequence'], {
            unique: true,
          });
        }
      };
    });
  }

  /**
   * Add items to the write queue.
   * Items will be written in a batched transaction.
   * @param rolloutId - Conversation ID
   * @param items - Array of rollout items to persist
   */
  async addItems(rolloutId: ConversationId, items: RolloutItem[]): Promise<void> {
    if (this.closed) return;

    if (items.length === 0) return;

    // Add write operation to the serialization queue
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.db || this.closed) return;

      return new Promise<void>((resolve, reject) => {
        try {
          const transaction = this.db!.transaction([STORE_ROLLOUT_ITEMS, STORE_ROLLOUTS], 'readwrite');
          const itemsStore = transaction.objectStore(STORE_ROLLOUT_ITEMS);
          const rolloutsStore = transaction.objectStore(STORE_ROLLOUTS);

          transaction.oncomplete = () => {
            resolve();
          };
          transaction.onerror = () => {
            reject(new Error(`Transaction failed: ${transaction.error?.message}`));
          };
          transaction.onabort = () => {
            reject(new Error('Transaction aborted'));
          };

          for (const item of items) {
            const record = {
              rolloutId,
              timestamp: formatTimestamp(new Date()),
              sequence: this.currentSequence++,
              type: item.type,
              payload: item.payload,
            };
            itemsStore.add(record);
          }

          // Update rollout metadata
          const getRequest = rolloutsStore.get(rolloutId);
          getRequest.onsuccess = () => {
            const metadata = getRequest.result as RolloutMetadataRecord | undefined;
            if (metadata) {
              metadata.itemCount += items.length;
              metadata.updated = Date.now();
              rolloutsStore.put(metadata);
            }
          };
        } catch (error) {
          reject(error);
        }
      });
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
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.flush();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.closed = true;
  }

  /**
   * Get the current sequence number.
   */
  getCurrentSequence(): number {
    return this.currentSequence;
  }
}
