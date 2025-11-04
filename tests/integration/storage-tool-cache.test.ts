/**
 * Integration tests for StorageTool with SessionCacheManager
 * Tests: T040-T042 - US1 Store Results integration and performance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { StorageTool } from '../../src/tools/StorageTool';
import { IndexedDBAdapter } from '../../src/storage/IndexedDBAdapter';

describe('Storage Tool Cache - Integration Tests', () => {
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

  describe('T040: Email Summaries Use Case', () => {
    it('should cache 10 email summaries, return metadata only, and list all items', async () => {
      // Create 10 email summary objects (~50KB each)
      const emailSummaries = [];
      for (let i = 1; i <= 10; i++) {
        const summary = {
          emailId: `email_${i}`,
          subject: `Email Subject ${i}`,
          from: `sender${i}@example.com`,
          to: [`recipient${i}@example.com`],
          date: new Date().toISOString(),
          body: 'x'.repeat(50 * 1024), // ~50KB of data
          attachments: [],
          labels: ['inbox', 'important']
        };
        emailSummaries.push(summary);
      }

      // Write each email summary to cache
      const writeResults = [];
      for (let i = 0; i < emailSummaries.length; i++) {
        const result = await tool.execute(
          {
            action: 'write',
            data: emailSummaries[i],
            description: `Email summary ${i + 1}: ${emailSummaries[i].subject}`
          },
          { metadata: { sessionId: 'conv_emails' } }
        );

        expect(result.success).toBe(true);
        expect(result.data.success).toBe(true);

        // Verify metadata returned (not full data)
        expect(result.data.metadata).toBeDefined();
        expect(result.data.metadata.storageKey).toMatch(/^conv_emails_[a-z0-9]{8}_[a-z0-9]{8}$/);
        expect(result.data.metadata.description).toContain(`Email summary ${i + 1}`);
        expect(result.data.metadata.dataSize).toBeGreaterThan(50000); // ~50KB
        expect(result.data.metadata).not.toHaveProperty('data'); // Should NOT include full data

        writeResults.push(result.data.metadata);
      }

      // List all cached items
      const listResult = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: 'conv_emails' } }
      );

      expect(listResult.success).toBe(true);
      expect(listResult.data.success).toBe(true);
      expect(listResult.data.items).toHaveLength(10);

      // Verify all items have descriptions and metadata only
      listResult.data.items.forEach((item: any, index: number) => {
        expect(item).not.toHaveProperty('data'); // Metadata only
        expect(item.description).toContain('Email summary');
        expect(item.sessionId).toBe('conv_emails');
        expect(item.dataSize).toBeGreaterThan(50000);
      });

      // Verify total size tracked correctly
      expect(listResult.data.totalSize).toBeGreaterThan(500000); // ~500KB total (10 * 50KB)
      expect(listResult.data.totalCount).toBe(10);
      expect(listResult.data.sessionQuotaUsed).toBeGreaterThan(0);
      expect(listResult.data.sessionQuotaRemaining).toBeLessThan(200 * 1024 * 1024); // Under 200MB limit
    });

    it('should handle reading specific email summaries by storage key', async () => {
      // Write one email summary
      const emailData = {
        emailId: 'email_test',
        subject: 'Test Email',
        body: 'x'.repeat(1000),
        from: 'test@example.com'
      };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: emailData,
          description: 'Test email for retrieval'
        },
        { metadata: { sessionId: 'conv_read_test' } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;

      // Read the specific email
      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey
        },
        { metadata: { sessionId: 'conv_read_test' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.success).toBe(true);
      expect(readResult.data.item.data).toEqual(emailData); // Full data returned
      expect(readResult.data.item.description).toBe('Test email for retrieval');
    });
  });

  describe('T041: Performance Requirements', () => {
    it('should write 1MB data in <100ms and return metadata <700 bytes', async () => {
      // Create 1MB of data
      const largeData = {
        content: 'x'.repeat(1024 * 1024), // 1MB
        metadata: {
          type: 'processed_document',
          timestamp: Date.now()
        }
      };

      const startTime = Date.now();

      const result = await tool.execute(
        {
          action: 'write',
          data: largeData,
          description: 'Large document: 1MB processed text with metadata for downstream analysis'
        },
        { metadata: { sessionId: 'conv_performance' } }
      );

      const duration = Date.now() - startTime;

      // SC-002: Verify write completes in <100ms
      expect(duration).toBeLessThan(100);

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);

      // SC-003: Verify metadata size is <700 bytes
      const metadataString = JSON.stringify(result.data.metadata);
      const metadataSize = new Blob([metadataString]).size;

      expect(metadataSize).toBeLessThan(700);
      expect(result.data.metadata.dataSize).toBeGreaterThan(1000000); // ~1MB
    });

    it('should perform multiple rapid writes efficiently', async () => {
      const data = { test: 'rapid fire', value: 123 };

      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(
          tool.execute(
            {
              action: 'write',
              data: { ...data, index: i },
              description: `Rapid write ${i}`
            },
            { metadata: { sessionId: 'conv_rapid' } }
          )
        );
      }

      const startTime = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.data.success).toBe(true);
      });

      // Should complete all 20 writes in reasonable time
      expect(duration).toBeLessThan(2000); // 2 seconds for 20 writes
    });
  });

  describe('T042: Description Truncation Edge Case', () => {
    it('should truncate descriptions longer than 500 characters with ellipsis', async () => {
      // Create 600-character description
      const longDescription = 'This is a very long description that exceeds the maximum allowed length of 500 characters. '.repeat(7);

      expect(longDescription.length).toBeGreaterThan(500);

      const result = await tool.execute(
        {
          action: 'write',
          data: { test: 'data with long description' },
          description: longDescription
        },
        { metadata: { sessionId: 'conv_truncate' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);

      // Verify description is truncated to exactly 500 characters
      expect(result.data.metadata.description.length).toBe(500);

      // Verify it ends with ellipsis
      expect(result.data.metadata.description.endsWith('...')).toBe(true);

      // Verify by reading the item back
      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey: result.data.metadata.storageKey
        },
        { metadata: { sessionId: 'conv_truncate' } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.description.length).toBe(500);
      expect(readResult.data.item.description.endsWith('...')).toBe(true);
    });

    it('should preserve descriptions exactly at 500 characters', async () => {
      const exactDescription = 'x'.repeat(500);

      const result = await tool.execute(
        {
          action: 'write',
          data: { test: 'exact length' },
          description: exactDescription
        },
        { metadata: { sessionId: 'conv_exact' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.description.length).toBe(500);
      expect(result.data.metadata.description).toBe(exactDescription);
    });

    it('should preserve short descriptions without truncation', async () => {
      const shortDescription = 'Short description under 500 chars';

      const result = await tool.execute(
        {
          action: 'write',
          data: { test: 'short' },
          description: shortDescription
        },
        { metadata: { sessionId: 'conv_short' } }
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.description).toBe(shortDescription);
      expect(result.data.metadata.description.length).toBe(shortDescription.length);
    });
  });

  describe('T050-T052: US2 Integration Tests', () => {
    it('T050: should support full write-list-read-delete cycle with data integrity', async () => {
      // Already covered above in "End-to-End Cache Lifecycle" test
    });

    it('T051: should retrieve items sequentially without context accumulation', async () => {
      const sessionId = 'conv_sequential';

      // Cache 5 items
      const keys = [];
      for (let i = 1; i <= 5; i++) {
        const result = await tool.execute(
          {
            action: 'write',
            data: { index: i, content: `Item ${i} data` },
            description: `Item ${i} for sequential retrieval`
          },
          { metadata: { sessionId } }
        );

        expect(result.success).toBe(true);
        keys.push(result.data.metadata.storageKey);
      }

      // Retrieve each in sequence - should not accumulate context
      for (let i = 0; i < keys.length; i++) {
        const readResult = await tool.execute(
          {
            action: 'read',
            storageKey: keys[i]
          },
          { metadata: { sessionId } }
        );

        expect(readResult.success).toBe(true);
        expect(readResult.data.item.data.index).toBe(i + 1);
        // Each read returns only requested item, not accumulating previous reads
      }

      // Verify no context overflow - all 5 items still accessible
      for (let i = 0; i < keys.length; i++) {
        const readResult = await tool.execute(
          {
            action: 'read',
            storageKey: keys[i]
          },
          { metadata: { sessionId } }
        );

        expect(readResult.success).toBe(true);
        expect(readResult.data.item.data.index).toBe(i + 1);
      }
    });

    it('T052: should retrieve 5KB item with full content for downstream processing', async () => {
      const sessionId = 'conv_5kb';

      // Create 5KB item
      const largeItem = {
        type: 'processed_document',
        content: 'x'.repeat(5 * 1024), // 5KB
        metadata: {
          processedAt: Date.now(),
          version: 1
        }
      };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: largeItem,
          description: '5KB processed document ready for downstream analysis'
        },
        { metadata: { sessionId } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;

      // Retrieve the item
      const readResult = await tool.execute(
        {
          action: 'read',
          storageKey
        },
        { metadata: { sessionId } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data).toEqual(largeItem);
      expect(readResult.data.item.data.content.length).toBe(5 * 1024);

      // Verify full content is ready for downstream processing
      expect(readResult.data.item.data.type).toBe('processed_document');
      expect(readResult.data.item.data.metadata.version).toBe(1);
    });
  });

  describe('T053-T054: Session Isolation', () => {
    it('T053-T054: should isolate cache entries by session', async () => {
      const sessionA = 'conv_session_a';
      const sessionB = 'conv_session_b';

      // Create items in session A
      const keysA = [];
      for (let i = 1; i <= 3; i++) {
        const result = await tool.execute(
          {
            action: 'write',
            data: { session: 'A', index: i },
            description: `Session A item ${i}`
          },
          { metadata: { sessionId: sessionA } }
        );

        expect(result.success).toBe(true);
        keysA.push(result.data.metadata.storageKey);
      }

      // Create items in session B
      const keysB = [];
      for (let i = 1; i <= 3; i++) {
        const result = await tool.execute(
          {
            action: 'write',
            data: { session: 'B', index: i },
            description: `Session B item ${i}`
          },
          { metadata: { sessionId: sessionB } }
        );

        expect(result.success).toBe(true);
        keysB.push(result.data.metadata.storageKey);
      }

      // Verify Session A can only list its own items
      const listA = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: sessionA } }
      );

      expect(listA.success).toBe(true);
      expect(listA.data.items).toHaveLength(3);
      listA.data.items.forEach((item: any) => {
        expect(item.sessionId).toBe(sessionA);
        expect(item.description).toContain('Session A');
      });

      // Verify Session B can only list its own items
      const listB = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId: sessionB } }
      );

      expect(listB.success).toBe(true);
      expect(listB.data.items).toHaveLength(3);
      listB.data.items.forEach((item: any) => {
        expect(item.sessionId).toBe(sessionB);
        expect(item.description).toContain('Session B');
      });

      // Verify Session A can read its own items
      for (const key of keysA) {
        const readResult = await tool.execute(
          { action: 'read', storageKey: key },
          { metadata: { sessionId: sessionA } }
        );

        expect(readResult.success).toBe(true);
        expect(readResult.data.item.data.session).toBe('A');
      }

      // Verify Session B can read its own items
      for (const key of keysB) {
        const readResult = await tool.execute(
          { action: 'read', storageKey: key },
          { metadata: { sessionId: sessionB } }
        );

        expect(readResult.success).toBe(true);
        expect(readResult.data.item.data.session).toBe('B');
      }

      // Verify sessions are completely isolated
      const statsA = await tool.getStats(sessionA);
      const statsB = await tool.getStats(sessionB);

      expect(statsA.itemCount).toBe(3);
      expect(statsB.itemCount).toBe(3);
      expect(statsA.sessionId).toBe(sessionA);
      expect(statsB.sessionId).toBe(sessionB);
    });
  });

  describe('End-to-End Cache Lifecycle', () => {
    it('should support full write-list-read-update-delete cycle', async () => {
      const sessionId = 'conv_lifecycle';

      // 1. Write initial data
      const writeResult = await tool.execute(
        {
          action: 'write',
          data: { version: 1, content: 'initial' },
          description: 'Initial version'
        },
        { metadata: { sessionId } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;

      // 2. List items
      const listResult1 = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId } }
      );

      expect(listResult1.success).toBe(true);
      expect(listResult1.data.items).toHaveLength(1);

      // 3. Read item
      const readResult = await tool.execute(
        { action: 'read', storageKey },
        { metadata: { sessionId } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data.version).toBe(1);

      // 4. Update item
      const updateResult = await tool.execute(
        {
          action: 'update',
          storageKey,
          data: { version: 2, content: 'updated' },
          description: 'Updated version'
        },
        { metadata: { sessionId } }
      );

      expect(updateResult.success).toBe(true);
      expect(updateResult.data.metadata.description).toBe('Updated version');

      // 5. Read updated item
      const readResult2 = await tool.execute(
        { action: 'read', storageKey },
        { metadata: { sessionId } }
      );

      expect(readResult2.success).toBe(true);
      expect(readResult2.data.item.data.version).toBe(2);
      expect(readResult2.data.item.data.content).toBe('updated');

      // 6. Delete item
      const deleteResult = await tool.execute(
        { action: 'delete', storageKey },
        { metadata: { sessionId } }
      );

      expect(deleteResult.success).toBe(true);

      // 7. Verify deleted
      const listResult2 = await tool.execute(
        { action: 'list' },
        { metadata: { sessionId } }
      );

      expect(listResult2.success).toBe(true);
      expect(listResult2.data.items).toHaveLength(0);
    });
  });

  describe('T071-T073: Progressive Updates Integration', () => {
    it('T071: should support progressive updates - cache partial then complete results', async () => {
      const sessionId = 'conv_progressive';

      // 1. Cache partial results (10 items)
      const partialData = {
        task: 'data_collection',
        items: Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          name: `Item ${i + 1}`,
          collected: Date.now()
        })),
        status: 'partial',
        progress: '10/15'
      };

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: partialData,
          description: 'Partial data collection results (10/15 items)',
          taskId: 'task_001',
          turnId: 'turn_001'
        },
        { metadata: { sessionId } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;
      const originalTimestamp = writeResult.data.metadata.timestamp;
      const originalSize = writeResult.data.metadata.dataSize;

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 2. Update with complete results (15 items total)
      const completeData = {
        task: 'data_collection',
        items: Array.from({ length: 15 }, (_, i) => ({
          id: i + 1,
          name: `Item ${i + 1}`,
          collected: Date.now()
        })),
        status: 'complete',
        progress: '15/15'
      };

      const updateResult = await tool.execute(
        {
          action: 'update',
          storageKey,
          data: completeData,
          description: 'Complete data collection results (15/15 items)'
        },
        { metadata: { sessionId } }
      );

      expect(updateResult.success).toBe(true);
      expect(updateResult.data.metadata.storageKey).toBe(storageKey); // Same key
      expect(updateResult.data.metadata.description).toBe('Complete data collection results (15/15 items)');
      expect(updateResult.data.metadata.timestamp).toBeGreaterThan(originalTimestamp);
      expect(updateResult.data.metadata.dataSize).toBeGreaterThan(originalSize); // More data

      // 3. Verify updated data is retrievable
      const readResult = await tool.execute(
        { action: 'read', storageKey },
        { metadata: { sessionId } }
      );

      expect(readResult.success).toBe(true);
      expect(readResult.data.item.data.items).toHaveLength(15);
      expect(readResult.data.item.data.status).toBe('complete');
      expect(readResult.data.item.data.progress).toBe('15/15');

      // Verify metadata reflects update
      expect(readResult.data.item.description).toBe('Complete data collection results (15/15 items)');
    });

    it('T072: should update metadata correctly - description, timestamp, dataSize', async () => {
      const sessionId = 'conv_metadata_update';

      // 1. Write initial item with small data
      const initialData = { version: 1, content: 'x'.repeat(1000) }; // ~1KB

      const writeResult = await tool.execute(
        {
          action: 'write',
          data: initialData,
          description: 'Initial version - small data'
        },
        { metadata: { sessionId } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;
      const timestamp1 = writeResult.data.metadata.timestamp;
      const size1 = writeResult.data.metadata.dataSize;

      expect(writeResult.data.metadata.description).toBe('Initial version - small data');
      expect(size1).toBeGreaterThan(0);
      expect(size1).toBeLessThan(2000); // ~1KB + overhead

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 2. Update with larger data
      const updatedData = { version: 2, content: 'y'.repeat(5000) }; // ~5KB

      const updateResult = await tool.execute(
        {
          action: 'update',
          storageKey,
          data: updatedData,
          description: 'Updated version - larger data'
        },
        { metadata: { sessionId } }
      );

      expect(updateResult.success).toBe(true);
      const timestamp2 = updateResult.data.metadata.timestamp;
      const size2 = updateResult.data.metadata.dataSize;

      // Verify description updated
      expect(updateResult.data.metadata.description).toBe('Updated version - larger data');

      // Verify timestamp updated (later than original)
      expect(timestamp2).toBeGreaterThan(timestamp1);

      // Verify dataSize increased
      expect(size2).toBeGreaterThan(size1);
      expect(size2).toBeGreaterThan(4000); // Should be ~5KB + overhead

      // 3. Update with smaller data
      const smallerData = { version: 3, content: 'z'.repeat(500) }; // ~500 bytes

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updateResult2 = await tool.execute(
        {
          action: 'update',
          storageKey,
          data: smallerData,
          description: 'Final version - minimal data'
        },
        { metadata: { sessionId } }
      );

      expect(updateResult2.success).toBe(true);
      const timestamp3 = updateResult2.data.metadata.timestamp;
      const size3 = updateResult2.data.metadata.dataSize;

      // Verify dataSize decreased
      expect(size3).toBeLessThan(size2);
      expect(size3).toBeLessThan(1500); // Should be ~500 bytes + overhead

      // Verify timestamp continues to increase
      expect(timestamp3).toBeGreaterThan(timestamp2);
    });

    it('T073: should handle concurrent updates - last write wins', async () => {
      const sessionId = 'conv_concurrent';

      // 1. Write initial item
      const writeResult = await tool.execute(
        {
          action: 'write',
          data: { version: 0, value: 'initial' },
          description: 'Initial state'
        },
        { metadata: { sessionId } }
      );

      expect(writeResult.success).toBe(true);
      const storageKey = writeResult.data.metadata.storageKey;

      // 2. Trigger concurrent updates
      const update1Promise = tool.execute(
        {
          action: 'update',
          storageKey,
          data: { version: 1, value: 'update_1', updatedBy: 'process_1' },
          description: 'Updated by process 1'
        },
        { metadata: { sessionId } }
      );

      const update2Promise = tool.execute(
        {
          action: 'update',
          storageKey,
          data: { version: 2, value: 'update_2', updatedBy: 'process_2' },
          description: 'Updated by process 2'
        },
        { metadata: { sessionId } }
      );

      // Wait for both updates to complete
      const [result1, result2] = await Promise.all([update1Promise, update2Promise]);

      // Both updates should succeed (last-write-wins)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // 3. Read final state - should be one of the updates (last write wins)
      const readResult = await tool.execute(
        { action: 'read', storageKey },
        { metadata: { sessionId } }
      );

      expect(readResult.success).toBe(true);

      // Verify data is from one of the updates (not corrupted)
      const finalData = readResult.data.item.data;
      const isUpdate1 = finalData.updatedBy === 'process_1' && finalData.version === 1;
      const isUpdate2 = finalData.updatedBy === 'process_2' && finalData.version === 2;

      expect(isUpdate1 || isUpdate2).toBe(true);

      // Verify no data corruption (version and updatedBy should match)
      if (finalData.updatedBy === 'process_1') {
        expect(finalData.version).toBe(1);
        expect(finalData.value).toBe('update_1');
      } else {
        expect(finalData.version).toBe(2);
        expect(finalData.value).toBe('update_2');
      }

      // Verify description matches the final update
      const finalDescription = readResult.data.item.description;
      expect(
        finalDescription === 'Updated by process 1' || finalDescription === 'Updated by process 2'
      ).toBe(true);
    });
  });
});
