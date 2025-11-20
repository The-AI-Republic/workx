import { describe, it, expect } from 'vitest';
import { parseNodeId } from '../utils';

describe('parseNodeId', () => {
  describe('frame-scoped format', () => {
    it('should parse "0:42" as main frame node', () => {
      const result = parseNodeId('0:42');
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(42);
    });

    it('should parse "1:42" as iframe 1 node', () => {
      const result = parseNodeId('1:42');
      expect(result.frameId).toBe(1);
      expect(result.backendNodeId).toBe(42);
    });

    it('should parse "5:999" as iframe 5 node', () => {
      const result = parseNodeId('5:999');
      expect(result.frameId).toBe(5);
      expect(result.backendNodeId).toBe(999);
    });

    it('should parse "0:-1" as main frame scroll target', () => {
      const result = parseNodeId('0:-1');
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(-1);
    });

    it('should parse "1:-1" as iframe scroll target', () => {
      const result = parseNodeId('1:-1');
      expect(result.frameId).toBe(1);
      expect(result.backendNodeId).toBe(-1);
    });
  });

  describe('backward compatibility', () => {
    it('should parse numeric 42 as main frame node', () => {
      const result = parseNodeId(42);
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(42);
    });

    it('should parse string "42" as main frame node', () => {
      const result = parseNodeId('42');
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(42);
    });

    it('should parse "-1" as main frame scroll target', () => {
      const result = parseNodeId('-1');
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(-1);
    });

    it('should parse numeric -1 as main frame scroll target', () => {
      const result = parseNodeId(-1);
      expect(result.frameId).toBe(0);
      expect(result.backendNodeId).toBe(-1);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid format with multiple colons', () => {
      expect(() => parseNodeId('1:2:3')).toThrow('Invalid node ID format');
    });

    it('should throw on non-numeric frame ID', () => {
      expect(() => parseNodeId('abc:42')).toThrow('Invalid node ID format');
    });

    it('should throw on non-numeric backend node ID', () => {
      expect(() => parseNodeId('1:abc')).toThrow('Invalid node ID format');
    });

    it('should throw on frame ID out of range (>5)', () => {
      expect(() => parseNodeId('6:42')).toThrow('Frame ID out of range');
    });

    it('should throw on negative frame ID', () => {
      expect(() => parseNodeId('-1:42')).toThrow('Frame ID out of range');
    });

    it('should throw on empty string', () => {
      expect(() => parseNodeId('')).toThrow('Invalid node ID format');
    });

    it('should throw on bare colon', () => {
      expect(() => parseNodeId(':')).toThrow('Invalid node ID format');
    });
  });
});
