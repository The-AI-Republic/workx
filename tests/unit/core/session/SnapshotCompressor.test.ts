/**
 * Unit tests for SnapshotCompressor utility functions
 *
 * Tests cover:
 * - Type guards (isDOMSnapshotOutput, isCompressedSnapshot)
 * - Compression function (compressSnapshot)
 * - Metadata preservation
 * - Edge cases and error handling
 */

import { describe, it, expect } from 'vitest';
import {
  isDOMSnapshotOutput,
  isCompressedSnapshot,
  compressSnapshot,
  COMPRESSED_SNAPSHOT_PLACEHOLDER,
} from '../../../../src/core/session/state/SnapshotCompressor';
import type { ResponseItem } from '../../../../src/protocol/types';

describe('SnapshotCompressor', () => {
  describe('isDOMSnapshotOutput', () => {
    it('should return true for valid DOM snapshot output', () => {
      const validSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_123',
        output: JSON.stringify({
          success: true,
          metadata: {
            toolName: 'browser_dom',
            duration: 50,
            tabId: 1,
          },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example Domain',
              },
              body: {
                node_id: 'root',
                tag: 'body',
                children: [],
              },
            },
          },
        }),
      };

      expect(isDOMSnapshotOutput(validSnapshot)).toBe(true);
    });

    it('should return false for non-function_call_output types', () => {
      const messageItem: ResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      };

      expect(isDOMSnapshotOutput(messageItem)).toBe(false);
    });

    it('should return false for function_call_output without DOM snapshot structure', () => {
      const nonSnapshotOutput: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_456',
        output: JSON.stringify({
          success: true,
          data: { result: 'some other tool output' },
        }),
      };

      expect(isDOMSnapshotOutput(nonSnapshotOutput)).toBe(false);
    });

    it('should return false for snapshots with wrong toolName', () => {
      const wrongToolSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_789',
        output: JSON.stringify({
          success: true,
          metadata: {
            toolName: 'different_tool',
          },
          data: {
            page: {
              context: { url: 'https://example.com', title: 'Test' },
              body: {},
            },
          },
        }),
      };

      expect(isDOMSnapshotOutput(wrongToolSnapshot)).toBe(false);
    });

    it('should return false for invalid JSON', () => {
      const invalidJsonSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_invalid',
        output: '{invalid json}',
      };

      expect(isDOMSnapshotOutput(invalidJsonSnapshot)).toBe(false);
    });

    it('should return false for snapshots with missing context', () => {
      const missingContextSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_missing',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              body: {},
            },
          },
        }),
      };

      expect(isDOMSnapshotOutput(missingContextSnapshot)).toBe(false);
    });
  });

  describe('isCompressedSnapshot', () => {
    it('should return true for compressed snapshots (body is string)', () => {
      const compressedSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_compressed',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example',
              },
              body: COMPRESSED_SNAPSHOT_PLACEHOLDER,
            },
          },
        }),
      };

      expect(isCompressedSnapshot(compressedSnapshot)).toBe(true);
    });

    it('should return false for uncompressed snapshots (body is object)', () => {
      const uncompressedSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_uncompressed',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example',
              },
              body: {
                node_id: 'root',
                tag: 'body',
              },
            },
          },
        }),
      };

      expect(isCompressedSnapshot(uncompressedSnapshot)).toBe(false);
    });

    it('should return false for non-function_call_output types', () => {
      const messageItem: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Test' }],
      };

      expect(isCompressedSnapshot(messageItem)).toBe(false);
    });

    it('should return false for invalid JSON', () => {
      const invalidItem: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_invalid',
        output: 'not json',
      };

      expect(isCompressedSnapshot(invalidItem)).toBe(false);
    });

    it('should return false for items without page structure', () => {
      const noPageItem: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_nopage',
        output: JSON.stringify({
          success: true,
          data: { result: 'something else' },
        }),
      };

      expect(isCompressedSnapshot(noPageItem)).toBe(false);
    });
  });

  describe('compressSnapshot', () => {
    it('should compress a valid DOM snapshot', () => {
      const originalSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_original',
        output: JSON.stringify({
          success: true,
          metadata: {
            toolName: 'browser_dom',
            duration: 100,
            tabId: 1,
          },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example Domain',
              },
              body: {
                node_id: 'body_123',
                tag: 'body',
                children: [
                  {
                    node_id: 'div_456',
                    tag: 'div',
                    text: 'Large DOM tree with many nodes...',
                  },
                ],
              },
            },
          },
        }),
      };

      const compressed = compressSnapshot(originalSnapshot);

      expect(compressed.type).toBe('function_call_output');
      expect(compressed.call_id).toBe('call_original');

      const parsed = JSON.parse(compressed.output);
      expect(parsed.success).toBe(true);
      expect(parsed.metadata.toolName).toBe('browser_dom');
      expect(parsed.data.page.context.url).toBe('https://example.com');
      expect(parsed.data.page.context.title).toBe('Example Domain');
      expect(parsed.data.page.body).toBe(COMPRESSED_SNAPSHOT_PLACEHOLDER);
    });

    it('should preserve URL and title metadata', () => {
      const snapshotWithMetadata: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_metadata',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              context: {
                url: 'https://github.com/anthropics/claude',
                title: 'Claude AI Repository',
              },
              body: { node_id: 'root', tag: 'body', children: [] },
            },
          },
        }),
      };

      const compressed = compressSnapshot(snapshotWithMetadata);
      const parsed = JSON.parse(compressed.output);

      expect(parsed.data.page.context.url).toBe(
        'https://github.com/anthropics/claude'
      );
      expect(parsed.data.page.context.title).toBe('Claude AI Repository');
    });

    it('should not compress already compressed snapshots', () => {
      const alreadyCompressed: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_already',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example',
              },
              body: COMPRESSED_SNAPSHOT_PLACEHOLDER,
            },
          },
        }),
      };

      const result = compressSnapshot(alreadyCompressed);

      // Should return the same item unchanged
      expect(result).toEqual(alreadyCompressed);
    });

    it('should not compress non-snapshot items', () => {
      const nonSnapshot: ResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
      };

      const result = compressSnapshot(nonSnapshot);
      expect(result).toEqual(nonSnapshot);
    });

    it('should not compress function_call_output that is not a DOM snapshot', () => {
      const otherFunctionOutput: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_other',
        output: JSON.stringify({
          success: true,
          data: { result: 'other tool result' },
        }),
      };

      const result = compressSnapshot(otherFunctionOutput);
      expect(result).toEqual(otherFunctionOutput);
    });

    it('should handle invalid JSON gracefully', () => {
      const invalidJsonItem: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_invalid',
        output: '{broken json',
      };

      const result = compressSnapshot(invalidJsonItem);
      // Should return original item unchanged
      expect(result).toEqual(invalidJsonItem);
    });

    it('should significantly reduce output size', () => {
      const largeSnapshot: ResponseItem = {
        type: 'function_call_output',
        call_id: 'call_large',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'browser_dom' },
          data: {
            page: {
              context: {
                url: 'https://example.com',
                title: 'Example',
              },
              body: {
                node_id: 'root',
                tag: 'body',
                children: Array(100).fill({
                  node_id: 'node',
                  tag: 'div',
                  text: 'Repeated content',
                }),
              },
            },
          },
        }),
      };

      const compressed = compressSnapshot(largeSnapshot);

      const originalSize = largeSnapshot.output.length;
      const compressedSize = compressed.output.length;

      // Compressed should be significantly smaller
      expect(compressedSize).toBeLessThan(originalSize * 0.5);
    });
  });
});
