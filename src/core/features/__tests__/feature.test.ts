/**
 * Track 22 — Phase 1 substrate tests.
 *
 * Under vitest there is no Vite `define`, so `__FEATURE_*__` is undefined and
 * every flag must resolve to `false` purely via the `typeof` guard — with no
 * throw and no dependence on process.env. This pins the "test/ts-node
 * fallback is inert and safe" contract.
 */
import { describe, it, expect } from 'vitest';
import { MCP, A2A, REMOTE_BRIDGE, X402, VOICE, FLAG_SNAPSHOT } from '../feature';
// Dependency-free .mjs matrix (repo root) — must be importable here too.
import {
  featureDefine,
  FLAG_NAMES,
  FLAG_DEFAULTS,
  // @ts-ignore - plain .mjs data module, no types by design
} from '../../../../vite.featureFlags.mjs';

describe('feature.ts (no Vite define — vitest)', () => {
  it('every flag is false via the typeof guard, no throw', () => {
    expect(MCP).toBe(false);
    expect(A2A).toBe(false);
    expect(REMOTE_BRIDGE).toBe(false);
    expect(X402).toBe(false);
    expect(VOICE).toBe(false);
  });

  it('does not depend on process.env (delete it, still false)', () => {
    const saved = process.env.WORKX_FEATURE_MCP;
    delete process.env.WORKX_FEATURE_MCP;
    process.env.WORKX_FEATURE_A2A = 'true'; // must NOT leak into compiled const
    expect(MCP).toBe(false);
    expect(A2A).toBe(false);
    if (saved !== undefined) process.env.WORKX_FEATURE_MCP = saved;
    delete process.env.WORKX_FEATURE_A2A;
  });

  it('FLAG_SNAPSHOT keys exactly match the canonical registry', () => {
    expect(Object.keys(FLAG_SNAPSHOT).sort()).toEqual([...FLAG_NAMES].sort());
    expect(Object.values(FLAG_SNAPSHOT).every((v) => v === false)).toBe(true);
  });
});

describe('vite.featureFlags.mjs', () => {
  it('FLAG_NAMES matches every per-platform default map', () => {
    for (const platform of Object.keys(FLAG_DEFAULTS)) {
      expect(Object.keys(FLAG_DEFAULTS[platform]).sort()).toEqual(
        [...FLAG_NAMES].sort()
      );
    }
  });

  it('featureDefine emits JSON-stringified booleans keyed __FEATURE_<NAME>__', () => {
    const d = featureDefine('extension', {});
    expect(d).toEqual({
      __FEATURE_MCP__: 'true',
      __FEATURE_A2A__: 'true',
      __FEATURE_REMOTE_BRIDGE__: 'false',
      __FEATURE_X402__: 'false',
      __FEATURE_VOICE__: 'false',
    });
  });

  it('WORKX_FEATURE_<NAME> overrides exactly one flag at build time', () => {
    const d = featureDefine('extension', { WORKX_FEATURE_X402: '1' });
    expect(d.__FEATURE_X402__).toBe('true');
    expect(d.__FEATURE_MCP__).toBe('true'); // unchanged default
    expect(d.__FEATURE_VOICE__).toBe('false'); // unchanged default
    const d2 = featureDefine('desktop', { WORKX_FEATURE_VOICE: 'false' });
    expect(d2.__FEATURE_VOICE__).toBe('false'); // desktop default true -> overridden
  });

  it('desktop/server defaults differ from extension (per-platform matrix)', () => {
    expect(featureDefine('extension', {}).__FEATURE_REMOTE_BRIDGE__).toBe('false');
    expect(featureDefine('desktop', {}).__FEATURE_REMOTE_BRIDGE__).toBe('true');
    expect(featureDefine('server', {}).__FEATURE_A2A__).toBe('false');
  });

  it('throws on an unknown platform', () => {
    expect(() => featureDefine('mobile', {})).toThrow(/unknown platform/);
  });
});
