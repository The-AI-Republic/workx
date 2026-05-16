import { describe, it, expect } from 'vitest';
import {
  setByPath,
  getByPath,
  deleteByPath,
  isPathLockedBy,
  flattenLeafPaths,
  deepClone,
} from '../pathUtils';

describe('pathUtils', () => {
  it('setByPath creates intermediates and replaces (arrays too)', () => {
    const o: Record<string, unknown> = { a: { b: { c: 1 } } };
    setByPath(o, 'a.b.c', 2);
    expect((o.a as any).b.c).toBe(2);
    setByPath(o, 'x.y.z', 'v');
    expect((o.x as any).y.z).toBe('v');
    setByPath(o, 'list', [1, 2]);
    setByPath(o, 'list', [9]);
    expect(o.list).toEqual([9]); // replace, not concat
  });

  it('setByPath overwrites a non-object segment with an object', () => {
    const o: Record<string, unknown> = { a: 5 };
    setByPath(o, 'a.b', 1);
    expect(o.a).toEqual({ b: 1 });
  });

  it('getByPath returns undefined for missing segments', () => {
    expect(getByPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });

  it('deleteByPath removes the leaf and prunes empty parents', () => {
    const o: Record<string, unknown> = { a: { b: { c: 1 }, d: 2 } };
    deleteByPath(o, 'a.b.c');
    expect(o).toEqual({ a: { d: 2 } }); // empty a.b pruned
    deleteByPath(o, 'a.d');
    expect(o).toEqual({}); // empty a pruned too
  });

  it('isPathLockedBy matches exact and descendant of a locked ancestor', () => {
    const locked = ['agent.providers.openai', 'agent.approval.mode'];
    expect(isPathLockedBy(locked, 'agent.approval.mode')).toBe(true);
    expect(isPathLockedBy(locked, 'agent.providers.openai.apiKey')).toBe(true);
    expect(isPathLockedBy(locked, 'agent.providers.xai.apiKey')).toBe(false);
    expect(isPathLockedBy(locked, 'agent.approval.modeX')).toBe(false);
  });

  it('flattenLeafPaths treats arrays as leaves', () => {
    expect(
      flattenLeafPaths({ a: { b: 1, c: [1, 2] }, d: 'x' }).sort()
    ).toEqual(['a.b', 'a.c', 'd']);
  });

  it('deepClone is independent of the source', () => {
    const src = { a: { b: [1] } };
    const c = deepClone(src);
    c.a.b.push(2);
    expect(src.a.b).toEqual([1]);
  });
});
