/**
 * Track 10c: policy core — loader, PluginPolicy, source allow/blocklist,
 * impersonation guards.
 */

import { describe, it, expect } from 'vitest';
import {
  PolicyLoader,
  PluginPolicy,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
  sourceMatches,
  isBlockedOfficialName,
  validateOfficialNameSource,
} from '../policy';
import type { PolicySettings } from '../policy';

function loader(json: string | null) {
  return new PolicyLoader({ readPolicyText: async () => json });
}

describe('PolicyLoader + PluginPolicy', () => {
  it('missing policy → empty (no restrictions)', async () => {
    const p = new PluginPolicy(loader(null));
    expect(await p.isBlocked('x@m')).toBe(false);
    expect(await p.isForceEnabled('x@m')).toBe(false);
  });

  it('corrupt policy → empty (logged, ignored)', async () => {
    const p = new PluginPolicy(loader('not json'));
    expect(await p.isBlocked('x@m')).toBe(false);
  });

  it('enabledPlugins false blocks, true force-enables', async () => {
    const p = new PluginPolicy(
      loader(JSON.stringify({ enabledPlugins: { 'a@m': false, 'b@m': true } })),
    );
    expect(await p.isBlocked('a@m')).toBe(true);
    expect(await p.isForceEnabled('a@m')).toBe(false);
    expect(await p.isForceEnabled('b@m')).toBe(true);
    expect(await p.isBlocked('b@m')).toBe(false);
  });

  it('invalidate forces a re-read', async () => {
    let json = JSON.stringify({ enabledPlugins: { 'a@m': false } });
    const l = new PolicyLoader({ readPolicyText: async () => json });
    const p = new PluginPolicy(l);
    expect(await p.isBlocked('a@m')).toBe(true);
    json = JSON.stringify({ enabledPlugins: {} });
    expect(await p.isBlocked('a@m')).toBe(true); // cached
    l.invalidate();
    expect(await p.isBlocked('a@m')).toBe(false); // re-read
  });

  it('pluginTrustMessage surfaces', async () => {
    const p = new PluginPolicy(loader(JSON.stringify({ pluginTrustMessage: 'Org says hi' })));
    expect(await p.getTrustMessage()).toBe('Org says hi');
  });
});

describe('source allow/blocklist', () => {
  it('null allowlist = no restriction; [] = deny-all', () => {
    expect(isSourceAllowedByPolicy('https://x.com/r', {} as PolicySettings)).toBe(true);
    expect(
      isSourceAllowedByPolicy('https://x.com/r', { strictKnownMarketplaces: [] }),
    ).toBe(false);
  });

  it('allowlist permits only matching sources', () => {
    const policy: PolicySettings = {
      strictKnownMarketplaces: [{ type: 'host', hostPattern: '*.corp.example.com' }],
    };
    expect(isSourceAllowedByPolicy('https://repos.corp.example.com/m', policy)).toBe(true);
    expect(isSourceAllowedByPolicy('https://evil.com/m', policy)).toBe(false);
  });

  it('blocklist trumps (non-empty only)', () => {
    const policy: PolicySettings = {
      blockedMarketplaces: [{ type: 'github', repo: 'bad/repo' }],
    };
    expect(isSourceInBlocklist('https://github.com/bad/repo', policy)).toBe(true);
    expect(isSourceAllowedByPolicy('https://github.com/bad/repo', policy)).toBe(false);
    expect(isSourceAllowedByPolicy('https://github.com/good/repo', policy)).toBe(true);
  });

  it('sourceMatches: github / host glob / path glob', () => {
    expect(sourceMatches('https://github.com/o/r', { type: 'github', repo: 'o/r' })).toBe(true);
    expect(sourceMatches('https://a.b.com/x', { type: 'host', hostPattern: '*.b.com' })).toBe(true);
    expect(sourceMatches('/corp/plugins/x', { type: 'path', pathPattern: '/corp/plugins/*' })).toBe(true);
  });
});

describe('impersonation guards', () => {
  it('blocks browserx/airepublic "official"-looking names', () => {
    expect(isBlockedOfficialName('browserx-official')).toBe(true);
    expect(isBlockedOfficialName('official-airepublic-plugins')).toBe(true);
    expect(isBlockedOfficialName('browserx_marketplace')).toBe(true);
    expect(isBlockedOfficialName('community-plugins')).toBe(false);
  });

  it('blocks non-ASCII (homograph) names', () => {
    expect(isBlockedOfficialName('br0wserх')).toBe(true); // cyrillic х
  });

  it('validateOfficialNameSource ok for non-reserved names', () => {
    // ALLOWED list is empty in v1 → every name is non-reserved → ok
    expect(validateOfficialNameSource('anything', 'https://github.com/x/y')).toEqual({
      ok: true,
    });
  });
});
