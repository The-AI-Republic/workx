/**
 * SessionCacheManager - Session-scoped cache management with quota enforcement
 *
 * Feature: 011-storage-cache
 * Tasks: T014-T026
 *
 * Provides:
 * - Storage key generation (sessionId_taskId_turnId)
 * - Session quota tracking (200MB per session)
 * - Global quota tracking (5GB total)
 * - Auto-eviction (oldest 50% when quota exceeded)
 * - Outdated cleanup (configurable, default 30 days)
 */

import { IndexedDBAdapter, STORE_NAMES, INDEX_NAMES } from './IndexedDBAdapter';
import { ConfigStorage } from './ConfigStorage';
import type {
  SessionCacheEntry,
  SessionCacheMetadata,
  LLMCacheConfig
} from '../types/storage';

/**
 * Cache metadata returned to LLM (without data payload)
 */
export interface CacheMetadata {
  storageKey: string;
  description: string;
  timestamp: number;
  dataSize: number;
  sessionId: string;
  taskId: string;
  turnId: string;
}

/**
 * Full cached item with data
 */
export interface CachedItem extends CacheMetadata {
  data: any;
  customMetadata?: Record<string, any>;
}

/**
 * Session cache statistics
 */
export interface SessionCacheStats {
  sessionId: string;
  totalSize: number;
  itemCount: number;
  quotaUsed: number; // Percentage 0-100
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Global cache statistics
 */
export interface GlobalCacheStats {
  totalSize: number;
  totalItems: number;
  sessionCount: number;
  quotaUsed: number; // Percentage of 5GB used
  oldestItemAge: number;
}

/**
 * Cache constants
 */
export const CACHE_CONSTANTS = {
  MAX_ITEM_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_SESSION_QUOTA: 200 * 1024 * 1024, // 200MB
  MAX_TOTAL_QUOTA: 5 * 1024 * 1024 * 1024, // 5GB
  MAX_DESCRIPTION_LENGTH: 500,
  TARGET_METADATA_SIZE: 700,
  ORPHAN_CLEANUP_THRESHOLD_MS: 24 * 60 * 60 * 1000, // 24 hours
  DEFAULT_OUTDATED_CLEANUP_DAYS: 30,
  NO_OUTDATED_CLEANUP: -1,
  SESSION_EVICTION_PERCENTAGE: 0.5
} as const;

/**
 * Error types
 */
export class CacheError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'CacheError';
  }
}

export class QuotaExceededError extends CacheError {
  constructor(
    public readonly currentSize: number,
    public readonly attemptedSize: number,
    public readonly quotaLimit: number
  ) {
    super(
      `Session quota exceeded: ${currentSize + attemptedSize} bytes exceeds ${quotaLimit} bytes`,
      'QUOTA_EXCEEDED',
      { currentSize, attemptedSize, quotaLimit }
    );
  }
}

export class DataTooLargeError extends CacheError {
  constructor(
    public readonly dataSize: number,
    public readonly maxSize: number
  ) {
    super(
      `Data too large: ${dataSize} bytes exceeds maximum ${maxSize} bytes`,
      'DATA_TOO_LARGE',
      { dataSize, maxSize }
    );
  }
}

export class ItemNotFoundError extends CacheError {
  constructor(public readonly storageKey: string) {
    super(
      `Item not found: ${storageKey}`,
      'ITEM_NOT_FOUND',
      { storageKey }
    );
  }
}

export class CorruptedDataError extends CacheError {
  constructor(
    public readonly storageKey: string,
    public readonly originalError: Error
  ) {
    super(
      `Cache item corrupted and cannot be parsed: ${storageKey}. Recovery: Delete this item and recreate it with fresh data. Original error: ${originalError.message}`,
      'CORRUPTED_DATA',
      { storageKey, originalError: originalError.message }
    );
  }
}

/**
 * SessionCacheManager - Main cache management class
 */
export class SessionCacheManager {
  private dbAdapter: IndexedDBAdapter;
  private configStorage: ConfigStorage;

  constructor(dbAdapter?: IndexedDBAdapter, configStorage?: ConfigStorage) {
    this.dbAdapter = dbAdapter || new IndexedDBAdapter();
    this.configStorage = configStorage || new ConfigStorage();
  }

  /**
   * Initialize the cache manager
   */
  async initialize(): Promise<void> {
    await this.dbAdapter.initialize();
  }

  // ==========================================================================
  // Storage Key Generation (T014-T016)
  // ==========================================================================

  /**
   * Generate a unique storage key
   * Format: {sessionId}_{taskId}_{turnId}
   */
  generateStorageKey(
    sessionId: string,
    taskId?: string,
    turnId?: string
  ): string {
    const finalTaskId = taskId || this.generateId();
    const finalTurnId = turnId || this.generateId();
    return `${sessionId}_${finalTaskId}_${finalTurnId}`;
  }

  /**
   * Generate 8-character alphanumeric ID using crypto.getRandomValues
   */
  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(8);
    crypto.getRandomValues(array);
    return Array.from(array, byte => chars[byte % chars.length]).join('');
  }

  /**
   * Validate storage key format
   * Format: {sessionId}_{taskId}_{turnId}
   * Task and turn IDs are always 8 alphanumeric chars
   */
  validateStorageKey(key: string): boolean {
    // Session ID starts with conv_, followed by task and turn IDs (8 chars each)
    const pattern = /^[^_]+_[a-z0-9]{8}_[a-z0-9]{8}$/;
    return pattern.test(key);
  }

  // ==========================================================================
  // Core Cache Operations (T017-T021, T027-T031)
  // ==========================================================================

  /**
   * Write data to cache with auto-eviction if quota exceeded
   */
  async write(
    sessionId: string,
    data: any,
    description: string,
    taskId?: string,
    turnId?: string,
    customMetadata?: Record<string, any>
  ): Promise<CacheMetadata> {
    await this.initialize();

    // Validate and serialize data
    const serialized = JSON.stringify(data);
    const dataSize = new Blob([serialized]).size;

    // Check item size limit
    if (dataSize > CACHE_CONSTANTS.MAX_ITEM_SIZE) {
      throw new DataTooLargeError(dataSize, CACHE_CONSTANTS.MAX_ITEM_SIZE);
    }

    // Truncate description if needed
    const truncatedDescription = description.length > CACHE_CONSTANTS.MAX_DESCRIPTION_LENGTH
      ? description.substring(0, CACHE_CONSTANTS.MAX_DESCRIPTION_LENGTH - 3) + '...'
      : description;

    // Generate storage key
    const storageKey = this.generateStorageKey(sessionId, taskId, turnId);
    const parts = storageKey.split('_');

    // Check quota and auto-evict if needed
    const stats = await this.getStats(sessionId);
    if (stats.totalSize + dataSize > CACHE_CONSTANTS.MAX_SESSION_QUOTA) {
      await this.autoEvict(sessionId);
    }

    // Create cache entry
    const entry: SessionCacheEntry = {
      storageKey,
      data,
      description: truncatedDescription,
      timestamp: Date.now(),
      dataSize,
      sessionId,
      taskId: parts[1],
      turnId: parts[2],
      customMetadata
    };

    // Store in IndexedDB
    await this.dbAdapter.put(STORE_NAMES.CACHE_ITEMS, entry);

    // Update session metadata
    await this.updateSessionMetadata(sessionId, dataSize, 1);

    // Return metadata only (not data)
    return this.extractMetadata(entry);
  }

  /**
   * Read cached item by storage key
   */
  async read(storageKey: string): Promise<CachedItem> {
    await this.initialize();

    const entry = await this.dbAdapter.get<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      storageKey
    );

    if (!entry) {
      throw new ItemNotFoundError(storageKey);
    }

    // Update session last accessed
    await this.updateSessionLastAccessed(entry.sessionId);

    try {
      // Attempt to parse/validate the data
      // If data is corrupted (malformed JSON, etc.), this will throw
      const cachedItem: CachedItem = {
        ...this.extractMetadata(entry),
        data: entry.data,
        customMetadata: entry.customMetadata
      };

      // Validate that data can be serialized (catches circular references, etc.)
      JSON.stringify(cachedItem.data);

      return cachedItem;
    } catch (error) {
      // Data is corrupted - throw CorruptedDataError with recovery guidance
      throw new CorruptedDataError(storageKey, error as Error);
    }
  }

  /**
   * List all cached items for a session (metadata only)
   */
  async list(sessionId: string): Promise<CacheMetadata[]> {
    await this.initialize();

    const entries = await this.dbAdapter.queryByIndex<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      INDEX_NAMES.BY_SESSION,
      sessionId
    );

    // Sort by timestamp descending (newest first)
    entries.sort((a, b) => b.timestamp - a.timestamp);

    return entries.map(entry => this.extractMetadata(entry));
  }

  /**
   * Delete cached item
   */
  async delete(storageKey: string): Promise<boolean> {
    await this.initialize();

    // Get item to know its size before deleting
    const entry = await this.dbAdapter.get<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      storageKey
    );

    if (!entry) {
      return false;
    }

    const deleted = await this.dbAdapter.delete(STORE_NAMES.CACHE_ITEMS, storageKey);

    if (deleted) {
      // Update session metadata
      await this.updateSessionMetadata(entry.sessionId, -entry.dataSize, -1);
    }

    return deleted;
  }

  /**
   * Update existing cached item
   */
  async update(
    storageKey: string,
    data: any,
    description: string,
    customMetadata?: Record<string, any>
  ): Promise<CacheMetadata> {
    await this.initialize();

    // Get existing entry
    const existing = await this.dbAdapter.get<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      storageKey
    );

    if (!existing) {
      throw new ItemNotFoundError(storageKey);
    }

    // Validate new data
    const serialized = JSON.stringify(data);
    const newDataSize = new Blob([serialized]).size;

    if (newDataSize > CACHE_CONSTANTS.MAX_ITEM_SIZE) {
      throw new DataTooLargeError(newDataSize, CACHE_CONSTANTS.MAX_ITEM_SIZE);
    }

    // Truncate description
    const truncatedDescription = description.length > CACHE_CONSTANTS.MAX_DESCRIPTION_LENGTH
      ? description.substring(0, CACHE_CONSTANTS.MAX_DESCRIPTION_LENGTH - 3) + '...'
      : description;

    // Update entry
    const updated: SessionCacheEntry = {
      ...existing,
      data,
      description: truncatedDescription,
      timestamp: Date.now(),
      dataSize: newDataSize,
      customMetadata
    };

    await this.dbAdapter.put(STORE_NAMES.CACHE_ITEMS, updated);

    // Update session metadata with size delta
    const sizeDelta = newDataSize - existing.dataSize;
    await this.updateSessionMetadata(existing.sessionId, sizeDelta, 0);

    return this.extractMetadata(updated);
  }

  // ==========================================================================
  // Quota Management & Auto-Eviction (T022-T026)
  // ==========================================================================

  /**
   * Auto-evict oldest 50% of items when session quota exceeded
   */
  private async autoEvict(sessionId: string): Promise<void> {
    const config = await this.configStorage.getLLMCacheConfig();
    const evictionPercentage = config.sessionEvictionPercentage;

    // Get all items for session, sorted by timestamp (oldest first)
    const entries = await this.dbAdapter.queryByIndex<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      INDEX_NAMES.BY_SESSION,
      sessionId
    );

    entries.sort((a, b) => a.timestamp - b.timestamp);

    // Calculate number of items to evict
    const evictCount = Math.ceil(entries.length * evictionPercentage);
    const itemsToEvict = entries.slice(0, evictCount);

    // Delete evicted items
    const keys = itemsToEvict.map(e => e.storageKey);
    await this.dbAdapter.batchDelete(STORE_NAMES.CACHE_ITEMS, keys);

    // Update session metadata
    const evictedSize = itemsToEvict.reduce((sum, e) => sum + e.dataSize, 0);
    await this.updateSessionMetadata(sessionId, -evictedSize, -evictCount);
  }

  /**
   * Get session statistics
   */
  async getStats(sessionId: string): Promise<SessionCacheStats> {
    await this.initialize();

    const metadata = await this.dbAdapter.get<SessionCacheMetadata>(
      STORE_NAMES.SESSIONS,
      sessionId
    );

    if (!metadata) {
      return {
        sessionId,
        totalSize: 0,
        itemCount: 0,
        quotaUsed: 0,
        createdAt: Date.now(),
        lastAccessedAt: Date.now()
      };
    }

    return metadata;
  }

  /**
   * Get global cache statistics
   */
  async getGlobalStats(): Promise<GlobalCacheStats> {
    await this.initialize();

    const allSessions = await this.dbAdapter.getAll<SessionCacheMetadata>(
      STORE_NAMES.SESSIONS
    );

    const totalSize = allSessions.reduce((sum, s) => sum + s.totalSize, 0);
    const totalItems = allSessions.reduce((sum, s) => sum + s.itemCount, 0);

    // Get oldest item age
    const allEntries = await this.dbAdapter.getAll<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS
    );

    const now = Date.now();
    const oldestItemAge = allEntries.length > 0
      ? Math.max(...allEntries.map(e => now - e.timestamp))
      : 0;

    return {
      totalSize,
      totalItems,
      sessionCount: allSessions.length,
      quotaUsed: (totalSize / CACHE_CONSTANTS.MAX_TOTAL_QUOTA) * 100,
      oldestItemAge
    };
  }

  /**
   * Check if global quota is exceeded
   */
  async checkGlobalQuota(): Promise<boolean> {
    const stats = await this.getGlobalStats();
    return stats.totalSize > CACHE_CONSTANTS.MAX_TOTAL_QUOTA;
  }

  // ==========================================================================
  // Session Management (T053-T066)
  // ==========================================================================

  /**
   * Clear all items for a session
   */
  async clearSession(sessionId: string): Promise<number> {
    await this.initialize();

    const entries = await this.dbAdapter.queryByIndex<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS,
      INDEX_NAMES.BY_SESSION,
      sessionId
    );

    const keys = entries.map(e => e.storageKey);
    const deletedCount = await this.dbAdapter.batchDelete(STORE_NAMES.CACHE_ITEMS, keys);

    // Delete session metadata
    await this.dbAdapter.delete(STORE_NAMES.SESSIONS, sessionId);

    return deletedCount;
  }

  /**
   * Cleanup orphaned sessions (idle > 24 hours)
   */
  async cleanupOrphans(maxAgeMs: number = CACHE_CONSTANTS.ORPHAN_CLEANUP_THRESHOLD_MS): Promise<number> {
    await this.initialize();

    const allSessions = await this.dbAdapter.getAll<SessionCacheMetadata>(
      STORE_NAMES.SESSIONS
    );

    const now = Date.now();
    const orphanedSessions = allSessions.filter(
      s => now - s.lastAccessedAt > maxAgeMs
    );

    let totalCleaned = 0;
    for (const session of orphanedSessions) {
      const count = await this.clearSession(session.sessionId);
      totalCleaned += count;
    }

    return totalCleaned;
  }

  /**
   * Cleanup outdated cache items
   */
  async cleanupOutdated(maxAgeDays?: number): Promise<number> {
    await this.initialize();

    const config = await this.configStorage.getLLMCacheConfig();
    const days = maxAgeDays ?? config.outdatedCleanupDays;

    // If -1, cleanup is disabled
    if (days === CACHE_CONSTANTS.NO_OUTDATED_CLEANUP) {
      return 0;
    }

    const maxAgeMs = days * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - maxAgeMs;

    // Query items older than cutoff
    const allEntries = await this.dbAdapter.getAll<SessionCacheEntry>(
      STORE_NAMES.CACHE_ITEMS
    );

    const outdatedEntries = allEntries.filter(e => e.timestamp < cutoffTime);
    const keys = outdatedEntries.map(e => e.storageKey);

    if (keys.length === 0) {
      return 0;
    }

    const deletedCount = await this.dbAdapter.batchDelete(STORE_NAMES.CACHE_ITEMS, keys);

    // Update session metadata for each affected session
    const sessionSizeMap = new Map<string, { size: number; count: number }>();
    for (const entry of outdatedEntries) {
      const existing = sessionSizeMap.get(entry.sessionId) || { size: 0, count: 0 };
      sessionSizeMap.set(entry.sessionId, {
        size: existing.size + entry.dataSize,
        count: existing.count + 1
      });
    }

    for (const [sessionId, { size, count }] of sessionSizeMap) {
      await this.updateSessionMetadata(sessionId, -size, -count);
    }

    return deletedCount;
  }

  /**
   * Get cache configuration
   */
  async getConfig(): Promise<LLMCacheConfig> {
    return this.configStorage.getLLMCacheConfig();
  }

  /**
   * Set cache configuration
   */
  async setConfig(config: Partial<LLMCacheConfig>): Promise<void> {
    await this.configStorage.setLLMCacheConfig(config);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Extract metadata from cache entry (without data)
   */
  private extractMetadata(entry: SessionCacheEntry): CacheMetadata {
    return {
      storageKey: entry.storageKey,
      description: entry.description,
      timestamp: entry.timestamp,
      dataSize: entry.dataSize,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      turnId: entry.turnId
    };
  }

  /**
   * Update session metadata
   */
  private async updateSessionMetadata(
    sessionId: string,
    sizeDelta: number,
    countDelta: number
  ): Promise<void> {
    let metadata = await this.dbAdapter.get<SessionCacheMetadata>(
      STORE_NAMES.SESSIONS,
      sessionId
    );

    const now = Date.now();

    if (!metadata) {
      metadata = {
        sessionId,
        totalSize: 0,
        itemCount: 0,
        quotaUsed: 0,
        createdAt: now,
        lastAccessedAt: now
      };
    }

    metadata.totalSize = Math.max(0, metadata.totalSize + sizeDelta);
    metadata.itemCount = Math.max(0, metadata.itemCount + countDelta);
    metadata.quotaUsed = (metadata.totalSize / CACHE_CONSTANTS.MAX_SESSION_QUOTA) * 100;
    metadata.lastAccessedAt = now;

    await this.dbAdapter.put(STORE_NAMES.SESSIONS, metadata);
  }

  /**
   * Update session last accessed time
   */
  private async updateSessionLastAccessed(sessionId: string): Promise<void> {
    await this.updateSessionMetadata(sessionId, 0, 0);
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.dbAdapter.close();
  }
}
