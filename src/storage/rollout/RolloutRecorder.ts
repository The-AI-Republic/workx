/**
 * RolloutRecorder - Main class for recording agent conversation rollouts
 *
 * Stores conversation history in IndexedDB with TTL support and pagination.
 */

import {
  type RolloutRecorderParams,
  type ConversationId,
  type RolloutItem,
  type InitialHistory,
  type ResumedHistory,
  type ConversationsPage,
  type Cursor,
  type IAgentConfigWithStorage,
  type RolloutMetadataRecord,
} from './types';
import { RolloutWriter } from './RolloutWriter';
import { APP_VERSION } from '@/config/version';
import { filterPersistedItems } from './policy';
import { listConversations as listConversationsImpl } from './listing';
import { cleanupExpired as cleanupExpiredImpl } from './cleanup';
import {
  isValidConversationId,
  createInvalidIdError,
  createRolloutNotFoundError,
  calculateExpiresAt,
  getCurrentTimestamp,
} from './helpers';
import { generatePlaceholderTitle } from '../../core/title';
import type { RolloutStorageProvider, StorageStats } from './provider/RolloutStorageProvider';
import { createRolloutStorageProvider } from './provider/createRolloutStorageProvider';

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

  // ==========================================================================
  // Provider Singleton
  // ==========================================================================

  private static _provider: RolloutStorageProvider | null = null;
  private static _providerPromise: Promise<RolloutStorageProvider> | null = null;

  /**
   * Get the storage provider (lazy-creates via factory on first call).
   */
  static async getProvider(): Promise<RolloutStorageProvider> {
    if (RolloutRecorder._provider) {
      return RolloutRecorder._provider;
    }
    if (!RolloutRecorder._providerPromise) {
      RolloutRecorder._providerPromise = createRolloutStorageProvider().then((p) => {
        RolloutRecorder._provider = p;
        RolloutRecorder._providerPromise = null;
        return p;
      }).catch((err) => {
        RolloutRecorder._providerPromise = null;
        throw err;
      });
    }
    return RolloutRecorder._providerPromise;
  }

  /**
   * Inject a provider for testing.
   */
  static setProvider(provider: RolloutStorageProvider): void {
    RolloutRecorder._provider = provider;
    RolloutRecorder._providerPromise = null;
  }

  /**
   * Reset the provider (test teardown).
   */
  static resetProvider(): void {
    RolloutRecorder._provider = null;
    RolloutRecorder._providerPromise = null;
  }

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
    const { sessionId, instructions } = params;

    // Validate conversation ID
    if (!isValidConversationId(sessionId)) {
      throw createInvalidIdError(sessionId);
    }

    // Calculate expiration
    const expiresAt = calculateExpiresAt(config);

    // Initialize writer with provider
    const provider = await RolloutRecorder.getProvider();
    const writer = await RolloutWriter.create(sessionId, 0, provider);

    // Create metadata record with placeholder title
    const now = Date.now();
    const metadata: RolloutMetadataRecord = {
      id: sessionId,
      created: now,
      updated: now,
      expiresAt,
      sessionMeta: {
        id: sessionId,
        timestamp: getCurrentTimestamp(),
        originator: 'chrome-extension',
        cliVersion: APP_VERSION,
        instructions,
        title: generatePlaceholderTitle(), // Placeholder title: "YYYY-MM-DD_HH-mm_chat"
      },
      itemCount: 0,
      status: 'active',
    };

    // Lazy initialization: don't write metadata or sessionMetaItem yet
    const recorder = new RolloutRecorder(writer, sessionId, false);
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

    // Initialize writer with correct sequence and provider
    const provider = await RolloutRecorder.getProvider();
    const writer = await RolloutWriter.create(rolloutId, lastSequence + 1, provider);

    return new RolloutRecorder(writer, rolloutId, true);
  }

  /**
   * Write metadata record via provider.
   */
  private static async writeMetadata(metadata: RolloutMetadataRecord): Promise<void> {
    const provider = await RolloutRecorder.getProvider();
    await provider.putMetadata(metadata);
  }

  /**
   * Load metadata record via provider.
   */
  private static async loadMetadata(
    rolloutId: ConversationId
  ): Promise<RolloutMetadataRecord | null> {
    const provider = await RolloutRecorder.getProvider();
    return provider.getMetadata(rolloutId);
  }

  /**
   * Get the last sequence number for a rollout via provider.
   */
  private static async getLastSequenceNumber(rolloutId: ConversationId): Promise<number> {
    const provider = await RolloutRecorder.getProvider();
    return provider.getLastSequenceNumber(rolloutId);
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
      sessionId: rolloutId,
      history,
      rolloutId,
    };

    return {
      type: 'resumed',
      payload: resumedHistory,
    };
  }

  /**
   * Load all rollout items for a conversation via provider.
   */
  private static async loadAllItems(rolloutId: ConversationId): Promise<RolloutItem[]> {
    const provider = await RolloutRecorder.getProvider();
    const records = await provider.getItemsByRolloutId(rolloutId);
    return records.map((record) => ({
      type: record.type as any,
      payload: record.payload,
    }));
  }

  /**
   * Clean up expired rollouts.
   * @returns Promise resolving to count of deleted rollouts
   */
  static async cleanupExpired(): Promise<number> {
    return cleanupExpiredImpl();
  }

  /**
   * Get storage statistics for all rollouts via provider.
   * @returns Promise resolving to storage stats
   */
  static async getStorageStats(): Promise<StorageStats> {
    const provider = await RolloutRecorder.getProvider();
    return provider.getStorageStats();
  }
}
