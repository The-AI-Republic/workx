/**
 * IndexedDB implementation of RolloutStorageProvider
 *
 * Mechanical extraction of existing IndexedDB code from RolloutRecorder,
 * RolloutWriter, listing.ts, and cleanup.ts into a single class.
 * Same DB schema: PiRollouts v2, stores: rollouts + rollout_items.
 */

import type { RolloutStorageProvider, StorageStats } from './RolloutStorageProvider';
import type {
  ConversationId,
  RolloutMetadataRecord,
  RolloutItemRecord,
  ConversationsPage,
  ConversationItem,
  Cursor,
} from '../types';
import {
  DB_NAME,
  DB_VERSION,
  STORE_ROLLOUTS,
  STORE_ROLLOUT_ITEMS,
} from '../types';
import { createDatabaseError } from '../helpers';

export class IndexedDBRolloutStorageProvider implements RolloutStorageProvider {
  private db: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    this.db = await this.openDatabase();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ==========================================================================
  // Metadata
  // ==========================================================================

  async getMetadata(rolloutId: ConversationId): Promise<RolloutMetadataRecord | null> {
    const db = this.getDb();
    return new Promise<RolloutMetadataRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUTS, 'readonly');
      const store = tx.objectStore(STORE_ROLLOUTS);
      const request = store.get(rolloutId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () =>
        reject(createDatabaseError('getMetadata', request.error?.message || 'unknown error'));
    });
  }

  async putMetadata(metadata: RolloutMetadataRecord): Promise<void> {
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUTS, 'readwrite');
      const store = tx.objectStore(STORE_ROLLOUTS);
      store.put(metadata);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(createDatabaseError('putMetadata', tx.error?.message || 'unknown error'));
      tx.onabort = () =>
        reject(createDatabaseError('putMetadata', 'Transaction aborted'));
    });
  }

  async deleteMetadata(rolloutId: ConversationId): Promise<void> {
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUTS, 'readwrite');
      const store = tx.objectStore(STORE_ROLLOUTS);
      store.delete(rolloutId);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(createDatabaseError('deleteMetadata', tx.error?.message || 'unknown error'));
    });
  }

  async getAllMetadata(): Promise<RolloutMetadataRecord[]> {
    const db = this.getDb();
    return new Promise<RolloutMetadataRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUTS, 'readonly');
      const store = tx.objectStore(STORE_ROLLOUTS);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result || []) as RolloutMetadataRecord[]);
      request.onerror = () =>
        reject(createDatabaseError('getAllMetadata', request.error?.message || 'unknown error'));
    });
  }

  // ==========================================================================
  // Items
  // ==========================================================================

  async addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>
  ): Promise<void> {
    if (items.length === 0) return;
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      try {
        const transaction = db.transaction([STORE_ROLLOUT_ITEMS, STORE_ROLLOUTS], 'readwrite');
        const itemsStore = transaction.objectStore(STORE_ROLLOUT_ITEMS);
        const rolloutsStore = transaction.objectStore(STORE_ROLLOUTS);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(new Error(`Transaction failed: ${transaction.error?.message}`));
        transaction.onabort = () =>
          reject(new Error('Transaction aborted'));

        for (const item of items) {
          itemsStore.add({
            rolloutId,
            timestamp: item.timestamp,
            sequence: item.sequence,
            type: item.type,
            payload: item.payload,
          });
        }

        // Update rollout metadata itemCount
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
  }

  async getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]> {
    const db = this.getDb();
    return new Promise<RolloutItemRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUT_ITEMS, 'readonly');
      const store = tx.objectStore(STORE_ROLLOUT_ITEMS);
      const index = store.index('rolloutId_sequence');
      const keyRange = IDBKeyRange.bound(
        [rolloutId, 0],
        [rolloutId, Number.MAX_SAFE_INTEGER]
      );
      const request = index.getAll(keyRange);
      request.onsuccess = () => resolve((request.result || []) as RolloutItemRecord[]);
      request.onerror = () =>
        reject(createDatabaseError('getItemsByRolloutId', request.error?.message || 'unknown error'));
    });
  }

  async getLastSequenceNumber(rolloutId: ConversationId): Promise<number> {
    const db = this.getDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUT_ITEMS, 'readonly');
      const store = tx.objectStore(STORE_ROLLOUT_ITEMS);
      const index = store.index('rolloutId_sequence');
      const keyRange = IDBKeyRange.bound(
        [rolloutId, 0],
        [rolloutId, Number.MAX_SAFE_INTEGER]
      );
      const request = index.openCursor(keyRange, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const record = cursor.value as RolloutItemRecord;
          resolve(record.sequence);
        } else {
          resolve(-1);
        }
      };
      request.onerror = () =>
        reject(createDatabaseError('getLastSequenceNumber', request.error?.message || 'unknown error'));
    });
  }

  async deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void> {
    if (rolloutIds.length === 0) return;
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ROLLOUT_ITEMS, 'readwrite');
      const store = tx.objectStore(STORE_ROLLOUT_ITEMS);
      const rolloutIdIndex = store.index('rolloutId');

      for (const rolloutId of rolloutIds) {
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

      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(createDatabaseError('deleteItemsByRolloutIds', tx.error?.message || 'unknown error'));
    });
  }

  // ==========================================================================
  // Listing & Cleanup
  // ==========================================================================

  async listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage> {
    // Check if IndexedDB is available
    if (typeof indexedDB === 'undefined') {
      console.warn('[listConversations] IndexedDB not available');
      return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
    }

    try {
      const db = this.getDb();

      if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
        return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
      }

      return await this.queryConversations(db, pageSize, cursor);
    } catch (err) {
      console.error('[listConversations] Error:', err);
      return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
    }
  }

  async cleanupExpired(): Promise<number> {
    const db = this.getDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction([STORE_ROLLOUTS, STORE_ROLLOUT_ITEMS], 'readwrite');
      const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);
      const itemsStore = tx.objectStore(STORE_ROLLOUT_ITEMS);
      const expiresAtIndex = rolloutsStore.index('expiresAt');

      const now = Date.now();
      const expiredIds: string[] = [];

      const keyRange = IDBKeyRange.upperBound(now);
      const cursorRequest = expiresAtIndex.openCursor(keyRange);

      cursorRequest.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (!cursor) {
          // Done scanning, now delete
          await this.deleteRolloutsAndItems(rolloutsStore, itemsStore, expiredIds);
          resolve(expiredIds.length);
          return;
        }

        const metadata = cursor.value;
        const expiresAt = metadata.expiresAt;

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

  async getStorageStats(): Promise<StorageStats> {
    const db = this.getDb();

    // Use a single transaction for all reads to avoid auto-commit between awaits
    return new Promise<StorageStats>((resolve, reject) => {
      const tx = db.transaction([STORE_ROLLOUTS, STORE_ROLLOUT_ITEMS], 'readonly');
      const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);
      const itemsStore = tx.objectStore(STORE_ROLLOUT_ITEMS);

      const rolloutsGetAllRequest = rolloutsStore.getAll();
      const itemsGetAllRequest = itemsStore.getAll();

      tx.oncomplete = () => {
        const rollouts = (rolloutsGetAllRequest.result || []) as RolloutMetadataRecord[];
        const items = (itemsGetAllRequest.result || []) as RolloutItemRecord[];

        resolve({
          rolloutCount: rollouts.length,
          itemCount: items.length,
          rolloutBytes: rollouts.reduce((total, r) => total + JSON.stringify(r).length, 0),
          itemBytes: items.reduce((total, i) => total + JSON.stringify(i).length, 0),
        });
      };

      tx.onerror = () =>
        reject(createDatabaseError('getStorageStats', tx.error?.message || 'unknown error'));
    });
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private getDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('IndexedDBRolloutStorageProvider not initialized. Call initialize() first.');
    }
    return this.db;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
          const rolloutsStore = db.createObjectStore(STORE_ROLLOUTS, { keyPath: 'id' });
          rolloutsStore.createIndex('created', 'created', { unique: false });
          rolloutsStore.createIndex('updated', 'updated', { unique: false });
          rolloutsStore.createIndex('expiresAt', 'expiresAt', { unique: false });
          rolloutsStore.createIndex('status', 'status', { unique: false });
        }

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

  private queryConversations(
    db: IDBDatabase,
    pageSize: number,
    cursor?: Cursor
  ): Promise<ConversationsPage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Query timed out'));
      }, 3000);

      try {
        if (!db.objectStoreNames.contains(STORE_ROLLOUTS)) {
          clearTimeout(timeout);
          resolve({ items: [], nextCursor: undefined, numScanned: 0, reachedCap: false });
          return;
        }

        const tx = db.transaction([STORE_ROLLOUTS], 'readonly');
        const rolloutsStore = tx.objectStore(STORE_ROLLOUTS);
        const request = rolloutsStore.getAll();

        request.onsuccess = () => {
          clearTimeout(timeout);
          try {
            const allRecords = (request.result || []) as RolloutMetadataRecord[];

            // Identify empty conversations to clean up
            const emptyRecordIds = allRecords
              .filter((r) => !r.sessionMeta || r.itemCount <= 1)
              .map((r) => r.id);

            // Passively clean up empty records in background
            if (emptyRecordIds.length > 0) {
              this.cleanupEmptyRecords(emptyRecordIds).catch((err) => {
                console.warn('[listing] Cleanup failed:', err);
              });
            }

            // Filter valid records, sort by updated desc
            let filtered = allRecords
              .filter((r) => r.sessionMeta && r.itemCount > 1)
              .sort((a, b) => b.updated - a.updated);

            // Apply cursor-based pagination
            if (cursor) {
              const cursorIndex = filtered.findIndex(
                (r) =>
                  r.updated < cursor.timestamp ||
                  (r.updated === cursor.timestamp && r.id <= cursor.id)
              );
              if (cursorIndex > 0) {
                filtered = filtered.slice(cursorIndex);
              }
            }

            const pageRecords = filtered.slice(0, pageSize);
            const hasMore = filtered.length > pageSize;

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

            const nextCursor = hasMore ? this.buildNextCursor(items) : undefined;

            resolve({
              items,
              nextCursor,
              numScanned: allRecords.length,
              reachedCap: false,
            });
          } catch (err) {
            reject(
              createDatabaseError(
                'process',
                err instanceof Error ? err.message : 'unknown error'
              )
            );
          }
        };

        request.onerror = () => {
          clearTimeout(timeout);
          reject(createDatabaseError('query', request.error?.message || 'unknown error'));
        };

        tx.onerror = () => {
          clearTimeout(timeout);
          reject(createDatabaseError('transaction', tx.error?.message || 'unknown error'));
        };
      } catch (err) {
        clearTimeout(timeout);
        reject(
          createDatabaseError('setup', err instanceof Error ? err.message : 'unknown error')
        );
      }
    });
  }

  private buildNextCursor(items: ConversationItem[]): Cursor | undefined {
    if (items.length === 0) return undefined;
    const lastItem = items[items.length - 1];
    return { timestamp: lastItem.updated, id: lastItem.id };
  }

  private async cleanupEmptyRecords(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      try {
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

        for (const id of recordIds) {
          rolloutsStore.delete(id);
        }

        if (stores.includes(STORE_ROLLOUT_ITEMS)) {
          const itemsStore = tx.objectStore(STORE_ROLLOUT_ITEMS);
          const rolloutIdIndex = itemsStore.index('rolloutId');

          for (const rolloutId of recordIds) {
            const range = IDBKeyRange.only(rolloutId);
            const cursorRequest = rolloutIdIndex.openCursor(range);
            cursorRequest.onsuccess = (event) => {
              const c = (event.target as IDBRequest<IDBCursorWithValue>).result;
              if (c) {
                c.delete();
                c.continue();
              }
            };
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(new Error(`Cleanup transaction failed: ${tx.error?.message}`));
      } catch (err) {
        reject(err);
      }
    });
  }

  private async deleteRolloutsAndItems(
    rolloutsStore: IDBObjectStore,
    itemsStore: IDBObjectStore,
    rolloutIds: string[]
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let completed = 0;
      const total = rolloutIds.length;

      if (total === 0) {
        resolve();
        return;
      }

      for (const rolloutId of rolloutIds) {
        const deleteRolloutRequest = rolloutsStore.delete(rolloutId);

        deleteRolloutRequest.onsuccess = () => {
          const itemsIndex = itemsStore.index('rolloutId');
          const keyRange = IDBKeyRange.only(rolloutId);
          const itemsCursorRequest = itemsIndex.openCursor(keyRange);

          itemsCursorRequest.onsuccess = (event) => {
            const itemsCursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (!itemsCursor) {
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
            reject(
              createDatabaseError(
                'deleteItems',
                itemsCursorRequest.error?.message || 'unknown error'
              )
            );
        };

        deleteRolloutRequest.onerror = () =>
          reject(
            createDatabaseError(
              'deleteRollout',
              deleteRolloutRequest.error?.message || 'unknown error'
            )
          );
      }
    });
  }
}
