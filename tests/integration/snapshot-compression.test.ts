/**
 * Integration test for dual recording compression flow
 *
 * Tests the complete flow of:
 * 1. Recording DOM snapshots to SessionState (in-memory)
 * 2. Compressing previous snapshots when new ones arrive
 * 3. Keeping latest snapshot fresh
 * 4. Compressing snapshots before persisting to Rollout storage
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../src/core/Session';
import type { ResponseItem } from '../../src/protocol/types';
import { isDOMSnapshotOutput, isCompressedSnapshot } from '../../src/core/session/state/SnapshotCompressor';

describe('Snapshot Compression Integration', () => {
  let session: Session;

  beforeEach(() => {
    // Create a non-persistent session (no rollout storage)
    session = new Session(false);
  });

  /**
   * Helper to create a mock DOM snapshot ResponseItem
   */
  function createDOMSnapshot(callId: string, url: string, title: string): ResponseItem {
    return {
      type: 'function_call_output',
      call_id: callId,
      // The output is stringified { data: SerializedDom, metadata } (from executeBrowserTool)
      output: JSON.stringify({
        data: {
          page: {
            context: {
              url,
              title,
            },
            body: {
              node_id: `body_${callId}`,
              tag: 'body',
              children: [
                {
                  node_id: `div_${callId}`,
                  tag: 'div',
                  text: `Large DOM content for ${url}`,
                },
              ],
            },
          },
        },
        metadata: {
          toolName: 'browser_dom',
          action: 'snapshot',
          duration: 50,
          tabId: 1,
        },
      }),
    };
  }

  /**
   * Helper to create a non-snapshot message
   */
  function createMessage(text: string): ResponseItem {
    return {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
    };
  }

  describe('SessionState compression (Logic 1)', () => {
    it('should keep first snapshot uncompressed when it is the only item', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://example.com', 'Example 1');

      await session.recordConversationItemsDual([snapshot1]);

      const history = session.getConversationHistory().items;
      expect(history.length).toBe(1);

      // First snapshot should remain uncompressed
      expect(isDOMSnapshotOutput(history[0])).toBe(true);
      expect(isCompressedSnapshot(history[0])).toBe(false);
    });

    it('should compress previous snapshot when new snapshot arrives', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://example.com/page1', 'Page 1');
      const snapshot2 = createDOMSnapshot('call_2', 'https://example.com/page2', 'Page 2');

      // Record first snapshot
      await session.recordConversationItemsDual([snapshot1]);

      // Record second snapshot - should compress the first one
      await session.recordConversationItemsDual([snapshot2]);

      const history = session.getConversationHistory().items;
      expect(history.length).toBe(2);

      // First snapshot should be compressed
      expect(isCompressedSnapshot(history[0])).toBe(true);

      // Second snapshot should remain fresh
      expect(isDOMSnapshotOutput(history[1])).toBe(true);
      expect(isCompressedSnapshot(history[1])).toBe(false);
    });

    it('should preserve metadata in compressed snapshots', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://github.com/test', 'GitHub Test');
      const snapshot2 = createDOMSnapshot('call_2', 'https://github.com/test2', 'GitHub Test 2');

      await session.recordConversationItemsDual([snapshot1]);
      await session.recordConversationItemsDual([snapshot2]);

      const history = session.getConversationHistory().items;
      const compressed = history[0];

      expect(compressed.type).toBe('function_call_output');
      if (compressed.type === 'function_call_output') {
        const parsed = JSON.parse(compressed.output);
        expect(parsed.data.page.context.url).toBe('https://github.com/test');
        expect(parsed.data.page.context.title).toBe('GitHub Test');
        expect(typeof parsed.data.page.body).toBe('string'); // Compressed to placeholder
      }
    });

    it('should handle multiple successive snapshots', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://example.com/1', 'Page 1');
      const snapshot2 = createDOMSnapshot('call_2', 'https://example.com/2', 'Page 2');
      const snapshot3 = createDOMSnapshot('call_3', 'https://example.com/3', 'Page 3');

      await session.recordConversationItemsDual([snapshot1]);
      await session.recordConversationItemsDual([snapshot2]);
      await session.recordConversationItemsDual([snapshot3]);

      const history = session.getConversationHistory().items;
      expect(history.length).toBe(3);

      // First two snapshots should be compressed
      expect(isCompressedSnapshot(history[0])).toBe(true);
      expect(isCompressedSnapshot(history[1])).toBe(true);

      // Latest snapshot should be fresh
      expect(isDOMSnapshotOutput(history[2])).toBe(true);
      expect(isCompressedSnapshot(history[2])).toBe(false);
    });

    it('should not compress snapshots when non-snapshot messages are recorded', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://example.com', 'Example');
      const message1 = createMessage('I see the page content');

      await session.recordConversationItemsDual([snapshot1]);
      await session.recordConversationItemsDual([message1]);

      const history = session.getConversationHistory().items;
      expect(history.length).toBe(2);

      // Snapshot should remain uncompressed (no new snapshot arrived)
      expect(isDOMSnapshotOutput(history[0])).toBe(true);
      expect(isCompressedSnapshot(history[0])).toBe(false);

      // Message is not a snapshot
      expect(history[1].type).toBe('message');
    });
  });

  describe('Mixed history scenarios', () => {
    it('should handle interleaved snapshots and messages', async () => {
      const snapshot1 = createDOMSnapshot('call_1', 'https://example.com/1', 'Page 1');
      const message1 = createMessage('Navigated to page 1');
      const snapshot2 = createDOMSnapshot('call_2', 'https://example.com/2', 'Page 2');
      const message2 = createMessage('Navigated to page 2');

      await session.recordConversationItemsDual([snapshot1]);
      await session.recordConversationItemsDual([message1]);
      await session.recordConversationItemsDual([snapshot2]);
      await session.recordConversationItemsDual([message2]);

      const history = session.getConversationHistory().items;
      expect(history.length).toBe(4);

      // First snapshot should be compressed (when second snapshot arrived)
      expect(isCompressedSnapshot(history[0])).toBe(true);

      // Second snapshot should remain fresh
      expect(isDOMSnapshotOutput(history[2])).toBe(true);
      expect(isCompressedSnapshot(history[2])).toBe(false);
    });
  });

  describe('Token reduction verification', () => {
    it('should significantly reduce token count through compression', async () => {
      // Create a larger, more realistic snapshot with nested DOM structure
      const largeSnapshot1: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_large_1',
        // The output is stringified { data: SerializedDom, metadata } (from executeBrowserTool)
        output: JSON.stringify({
          data: {
            page: {
              context: {
                url: 'https://example.com/large-page',
                title: 'Large Page with Lots of Content',
              },
              body: {
                node_id: 'body_root',
                tag: 'body',
                children: Array(50).fill(null).map((_, i) => ({
                  node_id: `div_${i}`,
                  tag: 'div',
                  text: `This is a large DOM node with significant content ${i}. It contains multiple paragraphs and nested elements.`,
                  children: [
                    {
                      node_id: `span_${i}`,
                      tag: 'span',
                      text: 'Nested content',
                    },
                  ],
                })),
              },
            },
          },
          metadata: {
            toolName: 'browser_dom',
            action: 'snapshot',
            duration: 150,
            tabId: 1,
          },
        }),
      };

      const snapshot2 = createDOMSnapshot('call_2', 'https://example.com/page2', 'Page 2');

      // Record first snapshot
      await session.recordConversationItemsDual([largeSnapshot1]);
      const originalSize1 = JSON.stringify(largeSnapshot1).length;

      // Record second snapshot (compresses first)
      await session.recordConversationItemsDual([snapshot2]);

      const history = session.getConversationHistory().items;
      const compressedSize1 = JSON.stringify(history[0]).length;

      // Compressed should be significantly smaller
      const reductionPercent = ((originalSize1 - compressedSize1) / originalSize1) * 100;
      expect(reductionPercent).toBeGreaterThan(60); // At least 60% reduction (as per spec SC-001)
    });
  });
});
