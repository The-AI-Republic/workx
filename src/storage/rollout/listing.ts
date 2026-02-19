/**
 * Conversation listing with cursor-based pagination
 * Queries IndexedDB for rollout summaries ordered by update time
 */

import type { ConversationsPage, Cursor, ConversationItem, RolloutMetadataRecord } from './types';
import { isValidUUID, createDatabaseError } from './helpers';

// ============================================================================
// Constants
// ============================================================================

const DB_NAME = 'PiRollouts';
const STORE_ROLLOUTS = 'rollouts';
const STORE_ROLLOUT_ITEMS = 'rollout_items';
const MAX_SCAN = 100; // Maximum records to scan per query

// ============================================================================
// Public API
// ============================================================================

/**
 * List conversations with cursor-based pagination.
 * @param pageSize - Number of items to return (1-100)
 * @param cursor - Optional cursor for pagination
 * @returns Promise resolving to ConversationsPage
 */
export async function listConversations(
  pageSize: number,
  cursor?: Cursor
): Promise<ConversationsPage> {
  // Check if IndexedDB is available
  if (typeof indexedDB === 'undefined') {
    console.warn('[listConversations] IndexedDB not available');
    return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
  }

  // Validate page size
  if (pageSize < 1 || pageSize > 100) {
    throw new Error('Invalid page size: must be between 1 and 100');
  }

  // Validate cursor if provided
  if (cursor) {
    if (isNaN(cursor.timestamp) || !isValidUUID(cursor.id)) {
      throw new Error('Invalid cursor: timestamp or ID is malformed');
    }
  }

  let db: IDBDatabase | null = null;
  try {
    // Open database
    db = await openDatabase();

    // If database doesn't exist, return empty result
    if (!db) {
      console.log('[listConversations] Database does not exist, returning empty');
      return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
    }

    const result = await queryConversations(db, pageSize, cursor);
    return result;
  } catch (err) {
    console.error('[listConversations] Error:', err);
    // Return empty result on error instead of throwing
    return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
  } finally {
    if (db) {
      db.close();
    }
  }
}

// ============================================================================
// Internal Implementation
// ============================================================================

/**
 * Open IndexedDB database for reading.
 * Opens without version to avoid blocking issues with other connections.
 * If database doesn't exist, returns null.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    console.log('[listing] Opening database...');

    // Add timeout for database open
    const timeout = setTimeout(() => {
      console.error('[listing] Database open timed out');
      reject(new Error('Database open timed out'));
    }, 3000);

    // Open without version - just read whatever exists
    // This avoids upgrade/blocking issues with other connections
    const request = indexedDB.open(DB_NAME);

    request.onsuccess = () => {
      clearTimeout(timeout);
      console.log('[listing] Database opened successfully');
      resolve(request.result);
    };

    request.onerror = () => {
      clearTimeout(timeout);
      // If database doesn't exist, return null instead of error
      console.log('[listing] Database does not exist or error:', request.error);
      resolve(null);
    };

    request.onblocked = () => {
      clearTimeout(timeout);
      console.error('[listing] Database open blocked');
      reject(new Error('Database open blocked'));
    };
  });
}

/**
 * Query conversations from IndexedDB with pagination.
 * Uses getAll() for simplicity - simpler than cursor and avoids async issues.
 */
function queryConversations(
  db: IDBDatabase,
  pageSize: number,
  cursor?: Cursor
): Promise<ConversationsPage> {
  return new Promise((resolve, reject) => {
    console.log('[listing] Querying conversations...');

    // Add timeout for query
    const timeout = setTimeout(() => {
      console.error('[listing] Query timed out');
      reject(new Error('Query timed out'));
    }, 3000);

    try {
      // Check if store exists
      if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
        clearTimeout(timeout);
        console.log('[listing] Store does not exist, returning empty');
        resolve({ items: [], nextCursor: undefined, numScanned: 0, reachedCap: false });
        return;
      }

      const tx = db.transaction([STORE_ROLLOUTS], 'readonly');
      const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);

      // Use getAll to fetch all records, then sort and filter in memory
      const request = rolloutsStore.getAll();

      request.onsuccess = () => {
        clearTimeout(timeout);
        try {
          const allRecords = (request.result || []) as RolloutMetadataRecord[];
          console.log('[listing] Got', allRecords.length, 'records from DB');

          // Identify empty conversations to clean up (no sessionMeta or only session_meta item)
          // Note: itemCount === 1 means only session_meta exists, no actual user messages
          const emptyRecordIds = allRecords
            .filter((r) => !r.sessionMeta || r.itemCount <= 1)
            .map((r) => r.id);

          // Passively clean up empty records in background (don't block listing)
          if (emptyRecordIds.length > 0) {
            console.log('[listing] Cleaning up', emptyRecordIds.length, 'empty conversations');
            cleanupEmptyRecords(db, emptyRecordIds).catch((err) => {
              console.warn('[listing] Cleanup failed:', err);
            });
          }

          // Filter valid records with sessionMeta and actual messages (itemCount > 1), then sort by updated (descending)
          let filtered = allRecords
            .filter((r) => r.sessionMeta && r.itemCount > 1)
            .sort((a, b) => b.updated - a.updated);

          // Apply cursor-based pagination
          if (cursor) {
            const cursorIndex = filtered.findIndex(
              (r) => r.updated < cursor.timestamp || (r.updated === cursor.timestamp && r.id <= cursor.id)
            );
            if (cursorIndex > 0) {
              filtered = filtered.slice(cursorIndex);
            }
          }

          // Take pageSize items
          const pageRecords = filtered.slice(0, pageSize);
          const hasMore = filtered.length > pageSize;

          // Convert to ConversationItems
          const items: ConversationItem[] = pageRecords.map((metadata) => ({
            id: metadata.id,
            rolloutId: metadata.id,
            head: [],
            tail: [],
            created: metadata.created,
            updated: metadata.updated,
            sessionMeta: metadata.sessionMeta,
            itemCount: metadata.itemCount,
          }));

          // Build nextCursor
          const nextCursor = hasMore ? buildNextCursor(items) : undefined;

          console.log('[listing] Returning', items.length, 'conversations');
          resolve({
            items,
            nextCursor,
            numScanned: allRecords.length,
            reachedCap: false,
          });
        } catch (err) {
          console.error('[listing] Process error:', err);
          reject(createDatabaseError('process', err instanceof Error ? err.message : 'unknown error'));
        }
      };

      request.onerror = () => {
        clearTimeout(timeout);
        console.error('[listing] Query error:', request.error);
        reject(createDatabaseError('query', request.error?.message || 'unknown error'));
      };

      tx.onerror = () => {
        clearTimeout(timeout);
        console.error('[listing] Transaction error:', tx.error);
        reject(createDatabaseError('transaction', tx.error?.message || 'unknown error'));
      };
    } catch (err) {
      clearTimeout(timeout);
      console.error('[listing] Setup error:', err);
      reject(createDatabaseError('setup', err instanceof Error ? err.message : 'unknown error'));
    }
  });
}

/**
 * Load head (first N) and tail (last N) records for a rollout.
 */
async function loadHeadTail(
  itemsStore: IDBObjectStore,
  rolloutId: string
): Promise<{ head: any[]; tail: any[] }> {
  return new Promise((resolve, reject) => {
    const index = itemsStore.index('rolloutId_sequence');
    const keyRange = IDBKeyRange.bound([rolloutId, 0], [rolloutId, Number.MAX_SAFE_INTEGER]);
    const request = index.getAll(keyRange, 10); // Get first 10 items

    request.onsuccess = () => {
      const allItems = request.result || [];
      const head = allItems.slice(0, 5); // First 5
      const tail = allItems.slice(-5); // Last 5
      resolve({ head, tail });
    };

    request.onerror = () => reject(createDatabaseError('loadHeadTail', request.error?.message || 'unknown error'));
  });
}

/**
 * Build nextCursor from the last item in results.
 */
function buildNextCursor(items: ConversationItem[]): Cursor | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const lastItem = items[items.length - 1];
  return {
    timestamp: lastItem.updated,
    id: lastItem.id,
  };
}

/**
 * Clean up empty conversation records from storage.
 * Deletes records from both rollouts and rollout_items stores.
 * Runs asynchronously to not block the listing operation.
 */
async function cleanupEmptyRecords(db: IDBDatabase, recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) {
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      // Check if stores exist
      if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
        resolve();
        return;
      }

      const stores = [STORE_ROLLOUTS];
      if (db.objectStoreNames.contains(STORE_ROLLOUT_ITEMS)) {
        stores.push(STORE_ROLLOUT_ITEMS);
      }

      const tx = db.transaction(stores, 'readwrite');
      const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);

      // Delete from rollouts store
      for (const id of recordIds) {
        rolloutsStore.delete(id);
      }

      // Delete associated items from rollout_items store
      if (stores.includes(STORE_ROLLOUT_ITEMS)) {
        const itemsStore = tx.objectStore(STORE_ROLLOUT_ITEMS);
        const rolloutIdIndex = itemsStore.index('rolloutId');

        for (const rolloutId of recordIds) {
          const range = IDBKeyRange.only(rolloutId);
          const cursorRequest = rolloutIdIndex.openCursor(range);

          cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        }
      }

      tx.oncomplete = () => {
        console.log('[listing] Cleaned up', recordIds.length, 'empty records');
        resolve();
      };

      tx.onerror = () => {
        reject(new Error(`Cleanup transaction failed: ${tx.error?.message}`));
      };
    } catch (err) {
      reject(err);
    }
  });
}
