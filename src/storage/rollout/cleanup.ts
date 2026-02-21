/**
 * TTL cleanup for expired rollouts
 * Deletes rollouts where expiresAt < now, cascading to rollout_items
 */

import { createDatabaseError } from './helpers';

// ============================================================================
// Constants
// ============================================================================

const DB_NAME = 'PiRollouts';
const STORE_ROLLOUTS = 'rollouts';
const STORE_ROLLOUT_ITEMS = 'rollout_items';

// ============================================================================
// Public API
// ============================================================================

/**
 * Clean up expired rollouts from IndexedDB.
 * Deletes rollouts where expiresAt < Date.now(), cascading to rollout_items.
 * Permanent rollouts (expiresAt = undefined) are never deleted.
 * @returns Promise resolving to count of deleted rollouts
 */
export async function cleanupExpired(): Promise<number> {
  const db = await openDatabase();

  try {
    const deletedCount = await deleteExpiredRollouts(db);
    return deletedCount;
  } finally {
    db.close();
  }
}

// ============================================================================
// Internal Implementation
// ============================================================================

/**
 * Open IndexedDB database for read/write.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(createDatabaseError('open', request.error?.message || 'unknown error'));
  });
}

/**
 * Delete expired rollouts and their items.
 */
async function deleteExpiredRollouts(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ROLLOUTS, STORE_ROLLOUT_ITEMS], 'readwrite');
    const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);
    const itemsStore = tx.objectStore(STORE_ROLLOUT_ITEMS);
    const expiresAtIndex = rolloutsStore.index('expiresAt');

    const now = Date.now();
    const expiredIds: string[] = [];

    // Query rollouts with expiresAt < now
    const keyRange = IDBKeyRange.upperBound(now);
    const cursorRequest = expiresAtIndex.openCursor(keyRange);

    cursorRequest.onsuccess = async (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (!cursor) {
        // Done scanning, now delete
        await deleteRolloutsAndItems(rolloutsStore, itemsStore, expiredIds);
        resolve(expiredIds.length);
        return;
      }

      const metadata = cursor.value;
      const expiresAt = metadata.expiresAt;

      // Skip permanent rollouts (expiresAt = undefined)
      if (expiresAt !== undefined && expiresAt < now) {
        expiredIds.push(metadata.id);
      }

      cursor.continue();
    };

    cursorRequest.onerror = () =>
      reject(createDatabaseError('query', cursorRequest.error?.message || 'unknown error'));

    tx.onerror = () =>
      reject(createDatabaseError('transaction', tx.error?.message || 'unknown error'));
  });
}

/**
 * Delete rollouts and their associated items.
 */
async function deleteRolloutsAndItems(
  rolloutsStore: IDBObjectStore,
  itemsStore: IDBObjectStore,
  rolloutIds: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = 0;
    const total = rolloutIds.length;

    if (total === 0) {
      resolve();
      return;
    }

    for (const rolloutId of rolloutIds) {
      // Delete rollout metadata
      const deleteRolloutRequest = rolloutsStore.delete(rolloutId);

      deleteRolloutRequest.onsuccess = () => {
        // Delete all rollout_items for this rollout
        const itemsIndex = itemsStore.index('rolloutId');
        const keyRange = IDBKeyRange.only(rolloutId);
        const itemsCursorRequest = itemsIndex.openCursor(keyRange);

        itemsCursorRequest.onsuccess = (event) => {
          const itemsCursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

          if (!itemsCursor) {
            // Done deleting items for this rollout
            completed++;
            if (completed === total) {
              resolve();
            }
            return;
          }

          itemsCursor.delete();
          itemsCursor.continue();
        };

        itemsCursorRequest.onerror = () =>
          reject(createDatabaseError('deleteItems', itemsCursorRequest.error?.message || 'unknown error'));
      };

      deleteRolloutRequest.onerror = () =>
        reject(createDatabaseError('deleteRollout', deleteRolloutRequest.error?.message || 'unknown error'));
    }
  });
}
