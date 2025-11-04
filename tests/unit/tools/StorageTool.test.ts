/**
 * Unit tests for StorageTool
 * Tests: T036 - StorageTool write/read/list/delete/update operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { StorageTool, CacheErrorType } from '../../../src/tools/StorageTool';
import { IndexedDBAdapter } from '../../../src/storage/IndexedDBAdapter';

describe('StorageTool', () => {
  let tool: StorageTool;
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    // @ts-ignore
    global.indexedDB = new IDBFactory();

    adapter = new IndexedDBAdapter();
    await adapter.initialize();

    tool = new StorageTool(adapter);
    await tool.initialize();
  });

  afterEach(async () => {
    await tool.close();

    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  describe('Tool Definition', () => {
    it('should have correct tool definition for LLM discovery', () => {
      const definition = tool.getDefinition();

      expect(definition.type).toBe('function');
      if (definition.type === 'function') {
        expect(definition.function.name).toBe('llm_cache');
        expect(definition.function.description).toContain('Cache intermediate results');
        expect(definition.function.description).toContain('200MB');
        expect(definition.function.parameters).toBeDefined();
      }
    });
  });

  describe('Write Operations', () => {
    it('should write data and return metadata only', async () => {
      const result = await tool.execute(
        {
          action: 'write',
          data: { test: 'data', numbers: [1, 2, 3] },
          description: 'Test cache entry'
        },
        { metadata: { sessionId: 'conv_test123' } }
      );

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('metadata');
      expect(result.data.metadata).toHaveProperty('storageKey');
      expect(result.data.metadata).toHaveProperty('description');
      expect(result.data.metadata).not.toHaveProperty('data'); // Metadata only
      expect(result.data.metadata.storageKey).toMatch(/^conv_test123_[a-z0-9]{8}_[a-z0-9]{8}$/);
    });

    it('should extract sessionId from options.metadata', async () => {
      const result = await tool.execute(
        {
          action: 'write',
          data: { value: 42 },
          description: 'Test'
        },
        { metadata: { sessionId: 'conv_abc' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.sessionId).toBe('conv_abc');
    });

    it('should return error when sessionId is missing', async () => {
      const result = await tool.execute({
        action: 'write',
        data: { value: 42 },
        description: 'Test'
      });

      // When executeImpl returns an error response (not throwing), it's still wrapped in success: true
      // because executeImpl completed successfully
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('Session ID is required');
    });

    it('should return error when data field is missing', async () => {
      const result = await tool.execute(
        {
          action: 'write',
          description: 'Test'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('data field is required');
    });

    it('should return error when description field is missing', async () => {
      const result = await tool.execute(
        {
          action: 'write',
          data: { value: 42 }
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('description field is required');
    });

    it('should truncate descriptions longer than 500 characters', async () => {
      const longDesc = 'x'.repeat(600);

      const result = await tool.execute(
        {
          action: 'write',
          data: { test: 'data' },
          description: longDesc
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.description.length).toBe(500);
      expect(result.data.metadata.description.endsWith('...')).toBe(true);
    });

    it('should return DataTooLargeError for items exceeding 5MB', async () => {
      const largeData = { content: 'x'.repeat(6 * 1024 * 1024) };

      const result = await tool.execute(
        {
          action: 'write',
          data: largeData,
          description: 'Too large'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.DATA_TOO_LARGE);
      expect(result.data.message).toContain('Data too large');
      expect(result.data.message).toContain('5MB');
    });

    it('should store custom metadata if provided', async () => {
      const customMeta = { tag: 'important', category: 'emails' };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: { test: 'data' },
          description: 'With metadata',
          customMetadata: customMeta
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(writeResult.success).toBe(true);

      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.customMetadata).toEqual(customMeta);
    });
  });

  describe('Read Operations', () => {
    it('should read full cached item with data', async () => {
      const testData = { value: 'test data', array: [1, 2, 3] };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: testData,
          description: 'Read test'
        },
        { metadata: { sessionId: 'conv_read' } }
      );

      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_read' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data).toEqual(testData);
      expect(readResult.data.item.description).toBe('Read test');
    });

    it('should return error when storageKey is missing', async () => {
      const result = await tool.execute(
        {
          action: 'read'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('storageKey field is required');
    });

    it('should return ItemNotFoundError for non-existent keys', async () => {
      const result = await tool.execute(
        {
          action: 'read',
          storageKey: 'conv_test_notfound1_notfound2'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.ITEM_NOT_FOUND);
      expect(result.data.message).toContain('Item not found');
      expect(result.data.storageKey).toBe('conv_test_notfound1_notfound2');
    });
  });

  describe('List Operations', () => {
    it('should list all items for a session (metadata only)', async () => {
      await tool.execute(
        { action: 'write', data: { data: 1 }, description: 'Item 1' },
        { metadata: { sessionId: 'conv_list' } }
      );
      await tool.execute(
        { action: 'write', data: { data: 2 }, description: 'Item 2' },
        { metadata: { sessionId: 'conv_list' } }
      );
      await tool.execute(
        { action: 'write', data: { data: 3 }, description: 'Item 3' },
        { metadata: { sessionId: 'conv_list' } }
      );
      await tool.execute(
        { action: 'write', data: { data: 4 }, description: 'Other session' },
        { metadata: { sessionId: 'conv_other' } }
      );

      const result = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: 'conv_list' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(3);
      result.data.items.forEach((item: any) => {
        expect(item).not.toHaveProperty('data'); // Metadata only
        expect(item.sessionId).toBe('conv_list');
      });
    });

    it('should include session quota stats in response', async () => {
      await tool.execute(
        { action: 'write', data: { test: 'data' }, description: 'Test' },
        { metadata: { sessionId: 'conv_quota' } }
      );

      const result = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: 'conv_quota' } }
      );

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('totalCount');
      expect(result.data).toHaveProperty('totalSize');
      expect(result.data).toHaveProperty('sessionQuotaUsed');
      expect(result.data).toHaveProperty('sessionQuotaRemaining');
      expect(result.data.totalCount).toBe(1);
    });

    it('should return empty array for session with no items', async () => {
      const result = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: 'conv_empty' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.items).toEqual([]);
      expect(result.data.totalCount).toBe(0);
    });
  });

  describe('Delete Operations', () => {
    it('should delete item and return success', async () => {
      const writeResult = await tool.execute(
        { action: 'write', data: { data: 'test' }, description: 'To delete' },
        { metadata: { sessionId: 'conv_del' } }
      );

      const deleteResult = await tool.execute(
        {
          action: 'delete',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_del' } }
      );

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.data.message).toContain('deleted successfully');

      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_del' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.success).toBe(false);
      expect(readResult.data.errorType).toBe(CacheErrorType.ITEM_NOT_FOUND);
    });

    it('should return error when storageKey is missing', async () => {
      const result = await tool.execute(
        { action: 'delete' },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('storageKey field is required');
    });

    it('should return error when deleting non-existent item', async () => {
      const result = await tool.execute(
        {
          action: 'delete',
          storageKey: 'conv_test_noexist1_noexist2'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.ITEM_NOT_FOUND);
    });
  });

  describe('Update Operations', () => {
    it('should update existing item with new data and description', async () => {
      const writeResult = await tool.execute(
        { action: 'write', data: { version: 1 }, description: 'Version 1' },
        { metadata: { sessionId: 'conv_upd' } }
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      const updateResult = await tool.execute(
        {
          action: 'update',
          storageKey: writeResult.data.metadata.storageKey,
          data: { version: 2, extra: 'data' },
          description: 'Version 2'
        },
        { metadata: { sessionId: 'conv_upd' } }
      );

      expect(updateResult.success).toBe(true);
      expect(updateResult.data.metadata.description).toBe('Version 2');

      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_upd' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data).toEqual({ version: 2, extra: 'data' });
    });

    it('should return error when required fields are missing', async () => {
      const result1 = await tool.execute(
        { action: 'update' },
        { metadata: { sessionId: 'conv_test' } }
      );
      expect(result1.success).toBe(true);
      expect(result1.data.success).toBe(false);
      expect(result1.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);

      const result2 = await tool.execute(
        { action: 'update', storageKey: 'key' },
        { metadata: { sessionId: 'conv_test' } }
      );
      expect(result2.success).toBe(true);
      expect(result2.data.success).toBe(false);
      expect(result2.data.message).toContain('data field is required');

      const result3 = await tool.execute(
        { action: 'update', storageKey: 'key', data: {} },
        { metadata: { sessionId: 'conv_test' } }
      );
      expect(result3.success).toBe(true);
      expect(result3.data.success).toBe(false);
      expect(result3.data.message).toContain('description field is required');
    });

    it('should return error when updating non-existent item', async () => {
      const result = await tool.execute(
        {
          action: 'update',
          storageKey: 'conv_test_noexist1_noexist2',
          data: { data: 'new' },
          description: 'New'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.ITEM_NOT_FOUND);
    });
  });

  describe('Error Handling', () => {
    it('should return error for unsupported action', async () => {
      const result = await tool.execute(
        {
          action: 'invalid_action' as any
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.VALIDATION_ERROR);
      expect(result.data.message).toContain('Unsupported cache action');
    });

    it('should convert SessionCacheManager errors to CacheErrorResponse', async () => {
      const largeData = { content: 'x'.repeat(6 * 1024 * 1024) };

      const result = await tool.execute(
        {
          action: 'write',
          data: largeData,
          description: 'Too large'
        },
        { metadata: { sessionId: 'conv_test' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe(CacheErrorType.DATA_TOO_LARGE);
      expect(result.data).toHaveProperty('dataSize');
      expect(result.data).toHaveProperty('maxSize');
    });
  });

  describe('Integration with SessionCacheManager', () => {
    it('should integrate with SessionCacheManager for full write-read cycle', async () => {
      const testData = { emails: ['email1', 'email2'], count: 2 };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: testData,
          description: 'Email summaries batch 1-2'
        },
        { metadata: { sessionId: 'conv_integration' } }
      );

      expect(writeResult.success).toBe(true);

      const listResult = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: 'conv_integration' } }
      );

      expect(listResult.success).toBe(true);
      expect(listResult.data.items).toHaveLength(1);

      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: writeResult.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_integration' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data).toEqual(testData);
    });

    it('should track quota correctly across operations', async () => {
      for (let i = 0; i < 5; i++) {
        await tool.execute(
          { action: 'write', data: { index: i }, description: `Item ${i}` },
          { metadata: { sessionId: 'conv_quota_test' } }
        );
      }

      const stats = await tool.getStats('conv_quota_test');

      expect(stats.itemCount).toBe(5);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.quotaUsed).toBeGreaterThan(0);
      expect(stats.quotaUsed).toBeLessThan(100);
    });
  });
});
