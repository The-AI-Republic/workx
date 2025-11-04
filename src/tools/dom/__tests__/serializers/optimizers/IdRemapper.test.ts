/**
 * Unit tests for IdRemapper
 * Test bidirectional mapping and sequential ID generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IdRemapper } from '../../../serializers/optimizers/IdRemapper';

describe('IdRemapper', () => {
  let remapper: IdRemapper;

  beforeEach(() => {
    remapper = new IdRemapper();
  });

  describe('registerNode', () => {
    it('should assign sequential IDs starting from 1', () => {
      const id1 = remapper.registerNode(52819);
      const id2 = remapper.registerNode(10423);
      const id3 = remapper.registerNode(99999);

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('should return same sequential ID for duplicate backendNodeId', () => {
      const id1 = remapper.registerNode(52819);
      const id2 = remapper.registerNode(52819);

      expect(id1).toBe(1);
      expect(id2).toBe(1);
    });

    it('should handle large backendNodeIds', () => {
      const largeId = 999999999;
      const sequentialId = remapper.registerNode(largeId);

      expect(sequentialId).toBe(1);
    });
  });

  describe('toBackendId', () => {
    it('should translate sequential ID to backendNodeId', () => {
      remapper.registerNode(52819);
      remapper.registerNode(10423);

      const backendId = remapper.toBackendId(2);
      expect(backendId).toBe(10423);
    });

    it('should return null for unknown sequential ID', () => {
      const backendId = remapper.toBackendId(999);
      expect(backendId).toBeNull();
    });
  });

  describe('toSequentialId', () => {
    it('should translate backendNodeId to sequential ID', () => {
      remapper.registerNode(52819);
      remapper.registerNode(10423);

      const sequentialId = remapper.toSequentialId(52819);
      expect(sequentialId).toBe(1);
    });

    it('should return null for unregistered backendNodeId', () => {
      const sequentialId = remapper.toSequentialId(99999);
      expect(sequentialId).toBeNull();
    });
  });

  describe('hasBackendId', () => {
    it('should return true for registered backendNodeId', () => {
      remapper.registerNode(52819);
      expect(remapper.hasBackendId(52819)).toBe(true);
    });

    it('should return false for unregistered backendNodeId', () => {
      expect(remapper.hasBackendId(99999)).toBe(false);
    });
  });

  describe('getNodeCount', () => {
    it('should return correct count of registered nodes', () => {
      expect(remapper.getNodeCount()).toBe(0);

      remapper.registerNode(1);
      remapper.registerNode(2);
      remapper.registerNode(3);

      expect(remapper.getNodeCount()).toBe(3);
    });

    it('should not double-count duplicate registrations', () => {
      remapper.registerNode(52819);
      remapper.registerNode(52819);
      remapper.registerNode(52819);

      expect(remapper.getNodeCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear all mappings and reset counter', () => {
      remapper.registerNode(52819);
      remapper.registerNode(10423);

      remapper.reset();

      expect(remapper.getNodeCount()).toBe(0);
      expect(remapper.toBackendId(1)).toBeNull();

      // Should restart from 1 after reset
      const newId = remapper.registerNode(99999);
      expect(newId).toBe(1);
    });
  });

  describe('getMappings', () => {
    it('should return all mappings sorted by sequential ID', () => {
      remapper.registerNode(52819);
      remapper.registerNode(10423);
      remapper.registerNode(77777);

      const mappings = remapper.getMappings();

      expect(mappings).toEqual([
        { sequentialId: 1, backendNodeId: 52819 },
        { sequentialId: 2, backendNodeId: 10423 },
        { sequentialId: 3, backendNodeId: 77777 }
      ]);
    });

    it('should return empty array when no nodes registered', () => {
      const mappings = remapper.getMappings();
      expect(mappings).toEqual([]);
    });
  });

  describe('bidirectional mapping integrity', () => {
    it('should maintain consistent bidirectional mapping', () => {
      const backendIds = [52819, 10423, 99999, 12345, 67890];
      const sequentialIds = backendIds.map(id => remapper.registerNode(id));

      // Test sequential → backend
      for (let i = 0; i < sequentialIds.length; i++) {
        const backendId = remapper.toBackendId(sequentialIds[i]);
        expect(backendId).toBe(backendIds[i]);
      }

      // Test backend → sequential
      for (let i = 0; i < backendIds.length; i++) {
        const sequentialId = remapper.toSequentialId(backendIds[i]);
        expect(sequentialId).toBe(sequentialIds[i]);
      }
    });
  });
});
