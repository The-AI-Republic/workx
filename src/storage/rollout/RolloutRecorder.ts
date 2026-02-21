/**
 * RolloutRecorder - Main class for recording agent conversation rollouts
 *
 * Stores conversation history in IndexedDB with TTL support and pagination.
 */

import {
  DB_NAME,
  DB_VERSION,
  STORE_ROLLOUTS,
  STORE_ROLLOUT_ITEMS,
  type RolloutRecorderParams,
  type ConversationId,
  type RolloutItem,
  type SessionMeta,
  type SessionMetaLine,
  type InitialHistory,
  type ResumedHistory,
  type ConversationsPage,
  type Cursor,
  type IAgentConfigWithStorage,
  type RolloutMetadataRecord,
  type RolloutItemRecord,
} from './types';
import { RolloutWriter } from './RolloutWriter';
import { filterPersistedItems } from './policy';
import { listConversations as listConversationsImpl } from './listing';
import { cleanupExpired as cleanupExpiredImpl } from './cleanup';
import {
  isValidConversationId,
  createInvalidIdError,
  createRolloutNotFoundError,
  createDatabaseError,
  calculateExpiresAt,
  getCurrentTimestamp,
} from './helpers';
import { generatePlaceholderTitle } from '../../core/title';

// ============================================================================
// RolloutRecorder Class
// ============================================================================

/**
 * Records and manages conversation rollouts in IndexedDB.
 * Supports create/resume, TTL management, and pagination.
 */
export class RolloutRecorder {
  private writer: RolloutWriter;
  private rolloutId: ConversationId;
  private isShutdown = false;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private pendingMetadata: RolloutMetadataRecord | null = null;
  private pendingSessionMeta: RolloutItem | null = null;

  private constructor(writer: RolloutWriter, rolloutId: ConversationId, initialized = false) {
    this.writer = writer;
    this.rolloutId = rolloutId;
    this.initialized = initialized;
  }

  // ==========================================================================
  // Constructor (Create Mode)
  // ==========================================================================

  /**
   * Create a new RolloutRecorder instance.
   * @param params - Create or resume parameters
   * @param config - Optional agent configuration with storage settings
   * @returns Promise resolving to RolloutRecorder instance
   */
  static async create(
    params: RolloutRecorderParams,
    config?: IAgentConfigWithStorage
  ): Promise<RolloutRecorder> {
    if (params.type === 'create') {
      return await RolloutRecorder.createNew(params, config);
    } else {
      return await RolloutRecorder.resumeExisting(params);
    }
  }

  /**
   * Create a new rollout.
   */
  private static async createNew(
    params: Extract<RolloutRecorderParams, { type: 'create' }>,
    config?: IAgentConfigWithStorage
  ): Promise<RolloutRecorder> {
    const { conversationId, instructions } = params;

    // Validate conversation ID
    if (!isValidConversationId(conversationId)) {
      throw createInvalidIdError(conversationId);
    }

    // Calculate expiration
    const expiresAt = calculateExpiresAt(config);

    // Initialize writer
    const writer = await RolloutWriter.create(conversationId, 0);

    // Create metadata record with placeholder title
    const now = Date.now();
    const metadata: RolloutMetadataRecord = {
      id: conversationId,
      created: now,
      updated: now,
      expiresAt,
      sessionMeta: {
        id: conversationId,
        timestamp: getCurrentTimestamp(),
        originator: 'chrome-extension',
        cliVersion: '1.0.0', // TODO: Load from package.json or config
        instructions,
        title: generatePlaceholderTitle(), // Placeholder title: "YYYY-MM-DD_HH-mm_chat"
      },
      itemCount: 0,
      status: 'active',
    };

    // Lazy initialization: don't write metadata or sessionMetaItem yet
    const recorder = new RolloutRecorder(writer, conversationId, false);
    recorder.pendingMetadata = metadata;
    recorder.pendingSessionMeta = {
      type: 'session_meta',
      payload: metadata.sessionMeta,
    };

    return recorder;
  }

  /**
   * Resume an existing rollout.
   */
  private static async resumeExisting(
    params: Extract<RolloutRecorderParams, { type: 'resume' }>
  ): Promise<RolloutRecorder> {
    const { rolloutId } = params;

    // Verify rollout exists
    const metadata = await RolloutRecorder.loadMetadata(rolloutId);
    if (!metadata) {
      throw createRolloutNotFoundError(rolloutId);
    }

    // Load last sequence number
    const lastSequence = await RolloutRecorder.getLastSequenceNumber(rolloutId);

    // Initialize writer with correct sequence
    const writer = await RolloutWriter.create(rolloutId, lastSequence + 1);

    return new RolloutRecorder(writer, rolloutId, true);
  }

  /**
   * Write metadata record to IndexedDB.
   */
  private static async writeMetadata(metadata: RolloutMetadataRecord): Promise<void> {
    const db = await RolloutRecorder.openDatabase();

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ROLLOUTS, 'readwrite');
        const store = tx.objectStore(STORE_ROLLOUTS);

        store.put(metadata);

        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () =>
          reject(createDatabaseError('writeMetadata', tx.error?.message || 'unknown error'));
        tx.onabort = () =>
          reject(createDatabaseError('writeMetadata', 'Transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  /**
   * Load metadata record from IndexedDB.
   */
  private static async loadMetadata(
    rolloutId: ConversationId
  ): Promise<RolloutMetadataRecord | null> {
    const db = await RolloutRecorder.openDatabase();

    try {
      return await new Promise<RolloutMetadataRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE_ROLLOUTS, 'readonly');
        const store = tx.objectStore(STORE_ROLLOUTS);

        const request = store.get(rolloutId);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(createDatabaseError('loadMetadata', request.error?.message || 'unknown error'));
      });
    } finally {
      db.close();
    }
  }

  /**
   * Get the last sequence number for a rollout.
   */
  private static async getLastSequenceNumber(rolloutId: ConversationId): Promise<number> {
    const db = await RolloutRecorder.openDatabase();

    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE_ROLLOUT_ITEMS, 'readonly');
        const store = tx.objectStore(STORE_ROLLOUT_ITEMS);
        const index = store.index('rolloutId_sequence');

        const keyRange = IDBKeyRange.bound(
          [rolloutId, 0],
          [rolloutId, Number.MAX_SAFE_INTEGER]
        );

        const request = index.openCursor(keyRange, 'prev'); // Get last item

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const record = cursor.value as RolloutItemRecord;
            resolve(record.sequence);
          } else {
            resolve(-1); // No items yet
          }
        };

        request.onerror = () =>
          reject(
            createDatabaseError('getLastSequenceNumber', request.error?.message || 'unknown error')
          );
      });
    } finally {
      db.close();
    }
  }

  /**
   * Open IndexedDB database.
   * Creates schema on first run or version upgrade.
   */
  private static openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create rollouts object store (metadata)
        if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
          const rolloutsStore = db.createObjectStore(STORE_ROLLOUTS, { keyPath: 'id' });
          rolloutsStore.createIndex('created', 'created', { unique: false });
          rolloutsStore.createIndex('updated', 'updated', { unique: false });
          rolloutsStore.createIndex('expiresAt', 'expiresAt', { unique: false });
          rolloutsStore.createIndex('status', 'status', { unique: false });
        }

        // Create rollout_items object store (conversation data)
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

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(createDatabaseError('open', request.error?.message || 'unknown error'));
    });
  }

  // ==========================================================================
  // Instance Methods
  // ==========================================================================

  /**
   * Record an array of rollout items.
   * Items are filtered by policy before persisting.
   * @param items - Array of rollout items to record
   */
  async recordItems(items: RolloutItem[]): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Recorder is shut down');
    }

    // Ensure metadata is written
    await this.ensureInitialized();

    if (items.length === 0) {
      return;
    }

    // Filter items by policy
    const filteredItems = filterPersistedItems(items);

    if (filteredItems.length === 0) {
      return;
    }

    // Pass to writer
    await this.writer.addItems(this.rolloutId, filteredItems);
  }

  /**
   * Record a turn completion event.
   * @param turnId - ID of the turn
   * @param stats - Statistics for the turn
   */
  async recordTurnCompletion(turnId: string, stats: any): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Recorder is shut down');
    }

    // Ensure metadata is written
    await this.ensureInitialized();

    const completionItem: RolloutItem = {
      type: 'turn_completion',
      payload: {
        turnId,
        stats,
      },
    };

    await this.writer.addItems(this.rolloutId, [completionItem]);
  }

  /**
   * Flush all pending writes to IndexedDB.
   */
  async flush(): Promise<void> {
    await this.writer.flush();
  }

  /**
   * Ensure the rollout is initialized in IndexedDB.
   * Writes metadata and session_meta item if not already done.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = (async () => {
      if (this.pendingMetadata && this.pendingSessionMeta) {
        try {
          // Write metadata to IndexedDB
          await RolloutRecorder.writeMetadata(this.pendingMetadata);

          // Write SessionMeta as first item (sequence 0)
          await this.writer.addItems(this.rolloutId, [this.pendingSessionMeta]);
          await this.writer.flush();

          this.initialized = true;
          this.pendingMetadata = null;
          this.pendingSessionMeta = null;
        } catch (error) {
          console.error('Lazy initialization failed:', error);
          throw error;
        } finally {
          this.initializingPromise = null;
        }
      }
    })();

    return this.initializingPromise;
  }

  /**
   * Get the rollout ID for this recorder.
   * @returns Conversation ID
   */
  getRolloutId(): ConversationId {
    return this.rolloutId;
  }

  /**
   * Shutdown the recorder.
   * Flushes pending writes and closes database connection.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return; // Idempotent
    }

    await this.writer.flush();
    await this.writer.close();
    this.isShutdown = true;
  }

  /**
   * Update the session title in metadata.
   * @param title - New title to set
   */
  async updateTitle(title: string): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Recorder is shut down');
    }

    if (this.initialized) {
      const metadata = await RolloutRecorder.loadMetadata(this.rolloutId);
      if (!metadata) {
        throw createRolloutNotFoundError(this.rolloutId);
      }

      metadata.sessionMeta.title = title;
      metadata.updated = Date.now();
      await RolloutRecorder.writeMetadata(metadata);
    } else if (this.pendingMetadata) {
      // If not initialized yet, just update the pending metadata
      this.pendingMetadata.sessionMeta.title = title;
      this.pendingMetadata.updated = Date.now();
    }
  }

  // ==========================================================================
  // Static Methods
  // ==========================================================================

  /**
   * List conversations with pagination.
   * @param pageSize - Number of items per page (1-100)
   * @param cursor - Optional cursor for pagination
   * @returns Promise resolving to ConversationsPage
   */
  static async listConversations(
    pageSize: number,
    cursor?: Cursor
  ): Promise<ConversationsPage> {
    // Validate page size
    if (pageSize < 1 || pageSize > 100) {
      throw new Error('Invalid page size: must be between 1 and 100');
    }

    return listConversationsImpl(pageSize, cursor);
  }

  /**
   * Get rollout history for a conversation.
   * @param rolloutId - Conversation ID
   * @returns Promise resolving to InitialHistory
   */
  static async getRolloutHistory(rolloutId: ConversationId): Promise<InitialHistory> {
    // Load metadata
    const metadata = await RolloutRecorder.loadMetadata(rolloutId);

    if (!metadata) {
      return { type: 'new' };
    }

    // Load all rollout items
    const history = await RolloutRecorder.loadAllItems(rolloutId);

    const resumedHistory: ResumedHistory = {
      conversationId: rolloutId,
      history,
      rolloutId,
    };

    return {
      type: 'resumed',
      payload: resumedHistory,
    };
  }

  /**
   * Load all rollout items for a conversation.
   */
  private static async loadAllItems(rolloutId: ConversationId): Promise<RolloutItem[]> {
    const db = await RolloutRecorder.openDatabase();

    try {
      return await new Promise<RolloutItem[]>((resolve, reject) => {
        const tx = db.transaction(STORE_ROLLOUT_ITEMS, 'readonly');
        const store = tx.objectStore(STORE_ROLLOUT_ITEMS);
        const index = store.index('rolloutId_sequence');

        const keyRange = IDBKeyRange.bound(
          [rolloutId, 0],
          [rolloutId, Number.MAX_SAFE_INTEGER]
        );

        const request = index.getAll(keyRange);

        request.onsuccess = () => {
          const records = request.result as RolloutItemRecord[];
          const items: RolloutItem[] = records.map((record) => ({
            type: record.type as any,
            payload: record.payload,
          }));
          resolve(items);
        };

        request.onerror = () =>
          reject(createDatabaseError('loadAllItems', request.error?.message || 'unknown error'));
      });
    } finally {
      db.close();
    }
  }

  /**
   * Clean up expired rollouts.
   * @returns Promise resolving to count of deleted rollouts
   */
  static async cleanupExpired(): Promise<number> {
    return cleanupExpiredImpl();
  }

  /**
   * Get storage statistics for all rollouts.
   * @returns Promise resolving to storage stats
   */
  static async getStorageStats(): Promise<{
    rolloutCount: number;
    itemCount: number;
    rolloutBytes: number;
    itemBytes: number;
  }> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(createDatabaseError('openDB', request.error?.message || 'unknown error'));
    });

    try {
      const stats = {
        rolloutCount: 0,
        itemCount: 0,
        rolloutBytes: 0,
        itemBytes: 0,
      };

      // Count rollouts
      const rolloutsStore = db.transaction(STORE_ROLLOUTS, 'readonly').objectStore(STORE_ROLLOUTS);
      const rolloutsCountRequest = rolloutsStore.count();
      stats.rolloutCount = await new Promise<number>((resolve, reject) => {
        rolloutsCountRequest.onsuccess = () => resolve(rolloutsCountRequest.result);
        rolloutsCountRequest.onerror = () => reject(createDatabaseError('countRollouts', rolloutsCountRequest.error?.message || 'unknown error'));
      });

      // Get all rollouts to calculate size
      const rolloutsGetAllRequest = rolloutsStore.getAll();
      const rollouts = await new Promise<RolloutMetadataRecord[]>((resolve, reject) => {
        rolloutsGetAllRequest.onsuccess = () => resolve(rolloutsGetAllRequest.result as RolloutMetadataRecord[]);
        rolloutsGetAllRequest.onerror = () => reject(createDatabaseError('getRollouts', rolloutsGetAllRequest.error?.message || 'unknown error'));
      });

      // Estimate rollout bytes
      stats.rolloutBytes = rollouts.reduce((total, rollout) => {
        return total + JSON.stringify(rollout).length;
      }, 0);

      // Count items
      const itemsStore = db.transaction(STORE_ROLLOUT_ITEMS, 'readonly').objectStore(STORE_ROLLOUT_ITEMS);
      const itemsCountRequest = itemsStore.count();
      stats.itemCount = await new Promise<number>((resolve, reject) => {
        itemsCountRequest.onsuccess = () => resolve(itemsCountRequest.result);
        itemsCountRequest.onerror = () => reject(createDatabaseError('countItems', itemsCountRequest.error?.message || 'unknown error'));
      });

      // Get all items to calculate size
      const itemsGetAllRequest = itemsStore.getAll();
      const items = await new Promise<RolloutItemRecord[]>((resolve, reject) => {
        itemsGetAllRequest.onsuccess = () => resolve(itemsGetAllRequest.result as RolloutItemRecord[]);
        itemsGetAllRequest.onerror = () => reject(createDatabaseError('getItems', itemsGetAllRequest.error?.message || 'unknown error'));
      });

      // Estimate item bytes
      stats.itemBytes = items.reduce((total, item) => {
        return total + JSON.stringify(item).length;
      }, 0);

      return stats;
    } finally {
      db.close();
    }
  }
}
