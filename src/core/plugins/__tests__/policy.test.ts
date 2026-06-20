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

  it('github matcher is path-anchored — no substring / adjacent / embed bypass', () => {
    const m = { type: 'github', repo: 'workx/official' } as const;
    // legitimate forms still match
    expect(sourceMatches('https://github.com/workx/official', m)).toBe(true);
    expect(sourceMatches('https://github.com/workx/official.git', m)).toBe(true);
    expect(sourceMatches('https://github.com/workx/official/', m)).toBe(true);
    expect(sourceMatches('git@github.com:workx/official.git', m)).toBe(true);
    expect(sourceMatches('workx/official', m)).toBe(true); // bare
    // adjacent-name collision must NOT satisfy an allowlist of workx/official
    expect(sourceMatches('https://github.com/workx/official-evil', m)).toBe(false);
    expect(sourceMatches('https://github.com/workx/officialX.git', m)).toBe(false);
    // wrong host / querystring embedding must NOT match
    expect(sourceMatches('https://evil.com/?x=github.com/workx/official', m)).toBe(false);
    expect(sourceMatches('https://github.com.evil.com/workx/official', m)).toBe(false);
  });

  it('allowlist is not bypassable by an adjacent github repo name', () => {
    const policy: PolicySettings = {
      strictKnownMarketplaces: [{ type: 'github', repo: 'workx/official' }],
    };
    expect(isSourceAllowedByPolicy('https://github.com/workx/official.git', policy)).toBe(true);
    expect(isSourceAllowedByPolicy('https://github.com/workx/official-evil', policy)).toBe(false);
  });
});

describe('impersonation guards', () => {
  it('blocks workx/airepublic "official"-looking names', () => {
    expect(isBlockedOfficialName('workx-official')).toBe(true);
    expect(isBlockedOfficialName('official-airepublic-plugins')).toBe(true);
    expect(isBlockedOfficialName('workx_marketplace')).toBe(true);
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
