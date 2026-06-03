/**
 * Track 10b: dependency closure resolution. Pure function — exhaustively
 * testable with an in-memory lookup map.
 */

import { describe, it, expect } from 'vitest';
import { resolveDependencyClosure } from '../dependencyResolver';
import type { DependencyLookup } from '../dependencyResolver';

function lookupFrom(map: Record<string, string[] | null>): DependencyLookup {
  return async (id) => {
    if (!(id in map)) return null;
    const deps = map[id];
    return deps === null ? null : { dependencies: deps };
  };
}

const NONE = new Set<string>();

describe('resolveDependencyClosure', () => {
  it('single plugin with no deps → just itself', async () => {
    const r = await resolveDependencyClosure('a@m', lookupFrom({ 'a@m': [] }), NONE, NONE);
    expect(r).toEqual({ ok: true, closure: ['a@m'] });
  });

  it('linear chain → post-order (deps first, root last)', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b'], 'b@m': ['c'], 'c@m': [] }),
      NONE,
      NONE,
    );
    expect(r).toEqual({ ok: true, closure: ['c@m', 'b@m', 'a@m'] });
  });

  it('diamond → no duplicate visit, post-order valid', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b', 'c'], 'b@m': ['d'], 'c@m': ['d'], 'd@m': [] }),
      NONE,
      NONE,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // d before b and c; b,c before a
      expect(r.closure.indexOf('d@m')).toBeLessThan(r.closure.indexOf('b@m'));
      expect(r.closure.indexOf('d@m')).toBeLessThan(r.closure.indexOf('c@m'));
      expect(r.closure.indexOf('b@m')).toBeLessThan(r.closure.indexOf('a@m'));
      expect(r.closure.filter((x) => x === 'd@m')).toHaveLength(1);
    }
  });

  it('cycle → reported with full chain', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b'], 'b@m': ['a'] }),
      NONE,
      NONE,
    );
    expect(r).toEqual({ ok: false, error: 'cycle', chain: ['a@m', 'b@m', 'a@m'] });
  });

  it('missing dependency → not-found', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['ghost'] }),
      NONE,
      NONE,
    );
    expect(r).toEqual({ ok: false, error: 'not-found', id: 'ghost@m' });
  });

  it('already-enabled dep is skipped (not in closure)', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b'], 'b@m': [] }),
      new Set(['b@m']),
      NONE,
    );
    expect(r).toEqual({ ok: true, closure: ['a@m'] });
  });

  it('root is NEVER skipped even if already enabled', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': [] }),
      new Set(['a@m']),
      NONE,
    );
    expect(r).toEqual({ ok: true, closure: ['a@m'] });
  });

  it('cross-marketplace dep blocked when not in allowlist', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b@other'], 'b@other': [] }),
      NONE,
      NONE,
    );
    expect(r).toEqual({
      ok: false,
      error: 'cross-marketplace',
      id: 'b@other',
      marketplace: 'other',
    });
  });

  it('cross-marketplace dep allowed when marketplace in allowlist', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b@other'], 'b@other': [] }),
      NONE,
      new Set(['other']),
    );
    expect(r).toEqual({ ok: true, closure: ['b@other', 'a@m'] });
  });

  it('cross-marketplace check runs AFTER alreadyEnabled (pre-installed dep OK)', async () => {
    const r = await resolveDependencyClosure(
      'a@m',
      lookupFrom({ 'a@m': ['b@other'] }),
      new Set(['b@other']), // manually pre-installed cross-mkt dep
      NONE, // not in allowlist — but alreadyEnabled short-circuits first
    );
    expect(r).toEqual({ ok: true, closure: ['a@m'] });
  });

  it('bare dependency name inherits the declaring plugin marketplace', async () => {
    const r = await resolveDependencyClosure(
      'a@official',
      lookupFrom({ 'a@official': ['b'], 'b@official': [] }),
      NONE,
      NONE,
    );
    expect(r).toEqual({ ok: true, closure: ['b@official', 'a@official'] });
  });
});
