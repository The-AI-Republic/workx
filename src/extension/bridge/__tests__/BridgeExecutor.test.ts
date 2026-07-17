import { describe, it, expect } from 'vitest';
import { capResultPayload } from '../BridgeExecutor';

describe('capResultPayload', () => {
  it('passes small results through unchanged', () => {
    const result = { nodes: [1, 2, 3], title: 'page' };
    expect(capResultPayload(result)).toBe(result);
    expect(capResultPayload(null)).toBeNull();
    expect(capResultPayload('text')).toBe('text');
  });

  it('replaces oversized results with a truncated preview envelope', () => {
    const big = { html: 'x'.repeat(900 * 1024) };
    const capped = capResultPayload(big) as {
      truncated: boolean;
      original_bytes: number;
      preview: string;
      note: string;
    };
    expect(capped.truncated).toBe(true);
    expect(capped.original_bytes).toBeGreaterThan(768 * 1024);
    expect(capped.preview.length).toBe(64 * 1024);
    expect(capped.note).toContain('truncated');
    // The envelope itself must comfortably fit under the wire limit.
    expect(JSON.stringify(capped).length).toBeLessThan(128 * 1024);
  });

  it('handles unserializable results without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const capped = capResultPayload(circular) as { truncated: boolean; original_bytes: null; note: string };
    expect(capped).toMatchObject({ truncated: true, original_bytes: null });
    expect(capped.note).toContain('not JSON-serializable');
    expect(() => JSON.stringify(capped)).not.toThrow();
  });

  it('caps multibyte results by encoded bytes rather than JavaScript string length', () => {
    // 400 Ki code units, but 1.2 MiB in UTF-8 — above the 1 MiB WS frame cap.
    const result = { text: '界'.repeat(400 * 1024) };
    const capped = capResultPayload(result) as {
      truncated: boolean;
      original_bytes: number;
      preview: string;
    };
    expect(capped.truncated).toBe(true);
    expect(capped.original_bytes).toBeGreaterThan(1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThan(768 * 1024);
  });
});
