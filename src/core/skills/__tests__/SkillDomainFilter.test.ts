import { describe, it, expect, beforeEach } from 'vitest';
import { SkillDomainFilter, matchesDomain } from '@/core/skills/SkillDomainFilter';
import type { SkillMeta } from '@/core/skills/types';

const meta = (overrides: Partial<SkillMeta>): SkillMeta => ({
  name: overrides.name ?? 's',
  description: overrides.description ?? '',
  invocationMode: overrides.invocationMode ?? 'manual',
  trusted: overrides.trusted ?? true,
  source: overrides.source ?? 'user',
  domains: overrides.domains,
  ...overrides,
});

describe('matchesDomain', () => {
  it('exact host match', () => {
    expect(matchesDomain('mail.google.com', 'mail.google.com')).toBe(true);
    expect(matchesDomain('Mail.Google.COM', 'mail.google.com')).toBe(true); // case-insensitive
  });

  it('exact host: no fuzzy match', () => {
    expect(matchesDomain('xmail.google.com', 'mail.google.com')).toBe(false);
    expect(matchesDomain('mail.google.com.example.com', 'mail.google.com')).toBe(false);
  });

  it('*.host: matches one segment', () => {
    expect(matchesDomain('mail.google.com', '*.google.com')).toBe(true);
    expect(matchesDomain('drive.google.com', '*.google.com')).toBe(true);
  });

  it('*.host: does NOT match the bare apex', () => {
    expect(matchesDomain('google.com', '*.google.com')).toBe(false);
  });

  it('*.host: does NOT match multiple segments', () => {
    expect(matchesDomain('a.b.google.com', '*.google.com')).toBe(false);
  });

  it('*.host: rejects unrelated hosts', () => {
    expect(matchesDomain('evil.com', '*.google.com')).toBe(false);
    expect(matchesDomain('google.com.evil.com', '*.google.com')).toBe(false);
  });
});

describe('SkillDomainFilter', () => {
  let filter: SkillDomainFilter;

  beforeEach(() => {
    filter = new SkillDomainFilter();
  });

  it('init: skills without domains are unconditional (always active)', () => {
    filter.init([
      meta({ name: 'a' }),
      meta({ name: 'b', domains: undefined }),
    ]);
    expect(filter.getActiveNames().sort()).toEqual(['a', 'b']);
    expect(filter.getConditionalNames()).toEqual([]);
  });

  it('init: skills with domains start conditional', () => {
    filter.init([
      meta({ name: 'gmail', domains: ['mail.google.com'] }),
      meta({ name: 'unconditional' }),
    ]);
    expect(filter.getActiveNames()).toEqual(['unconditional']);
    expect(filter.getConditionalNames()).toEqual(['gmail']);
  });

  it("init: domains: ['*'] is treated as unconditional", () => {
    filter.init([meta({ name: 'all', domains: ['*'] })]);
    expect(filter.getActiveNames()).toEqual(['all']);
    expect(filter.getConditionalNames()).toEqual([]);
  });

  it('onActiveTabChange: promotes matching skill, returns name in activated', () => {
    filter.init([meta({ name: 'gmail', domains: ['mail.google.com'] })]);
    const delta = filter.onActiveTabChange('mail.google.com');
    expect(delta.activated).toEqual(['gmail']);
    expect(delta.deactivated).toEqual([]);
    expect(filter.isAvailable('gmail')).toBe(true);
  });

  it('onActiveTabChange: demotes when navigating away (BIDIRECTIONAL — vs claudy monotonic)', () => {
    filter.init([meta({ name: 'gmail', domains: ['mail.google.com'] })]);
    filter.onActiveTabChange('mail.google.com');
    const delta = filter.onActiveTabChange('github.com');
    expect(delta.activated).toEqual([]);
    expect(delta.deactivated).toEqual(['gmail']);
    expect(filter.isAvailable('gmail')).toBe(false);
  });

  it('onActiveTabChange: handles wildcard domain promotion', () => {
    filter.init([meta({ name: 'google', domains: ['*.google.com'] })]);
    expect(filter.isAvailable('google')).toBe(false);
    filter.onActiveTabChange('drive.google.com');
    expect(filter.isAvailable('google')).toBe(true);
    filter.onActiveTabChange('mail.google.com');
    expect(filter.isAvailable('google')).toBe(true);
    filter.onActiveTabChange('github.com');
    expect(filter.isAvailable('google')).toBe(false);
  });

  it('onActiveTabChange: unconditional skills stay active across nav', () => {
    filter.init([
      meta({ name: 'always' }),
      meta({ name: 'gmail', domains: ['mail.google.com'] }),
    ]);
    filter.onActiveTabChange('mail.google.com');
    expect(filter.getActiveNames().sort()).toEqual(['always', 'gmail']);
    filter.onActiveTabChange('github.com');
    expect(filter.getActiveNames()).toEqual(['always']);
  });

  it('onActiveTabChange: null/undefined hostname demotes everything conditional', () => {
    filter.init([meta({ name: 'gmail', domains: ['mail.google.com'] })]);
    filter.onActiveTabChange('mail.google.com');
    const delta = filter.onActiveTabChange(null);
    expect(delta.deactivated).toEqual(['gmail']);
    expect(filter.isAvailable('gmail')).toBe(false);
  });

  it('multiple domains: any match promotes', () => {
    filter.init([
      meta({ name: 'multi', domains: ['gmail.com', '*.google.com'] }),
    ]);
    filter.onActiveTabChange('drive.google.com');
    expect(filter.isAvailable('multi')).toBe(true);
  });

  it('getAvailableSkills returns SkillMeta objects', () => {
    filter.init([
      meta({ name: 'a', description: 'Alpha' }),
      meta({ name: 'b', description: 'Beta', domains: ['gmail.com'] }),
    ]);
    filter.onActiveTabChange('gmail.com');
    const names = filter.getAvailableSkills().map((s) => s.name).sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('init() resets prior state', () => {
    filter.init([meta({ name: 'gmail', domains: ['gmail.com'] })]);
    filter.onActiveTabChange('gmail.com');
    expect(filter.isAvailable('gmail')).toBe(true);
    filter.init([meta({ name: 'github' })]);
    expect(filter.getActiveNames()).toEqual(['github']);
    expect(filter.isAvailable('gmail')).toBe(false);
  });

  // Regression test for B3: the bootstrap race where the adapter's seed
  // snapshot fires onActiveTabChange BEFORE init() has populated the maps.
  // The fix is to replay the snapshot through onActiveTabChange after
  // discover() completes. This test simulates that ordering.
  describe('B3 — early snapshot before init', () => {
    it('onActiveTabChange against empty maps is a no-op', () => {
      // Filter starts uninitialised — no init() called yet.
      const delta = filter.onActiveTabChange('gmail.com');
      expect(delta.activated).toEqual([]);
      expect(delta.deactivated).toEqual([]);
      expect(filter.getActiveNames()).toEqual([]);
    });

    it('replay after init activates the matching skill', () => {
      // 1. Subscriber fires while maps are empty (race window).
      filter.onActiveTabChange('gmail.com');
      expect(filter.getActiveNames()).toEqual([]);

      // 2. discover() completes → init() populates maps.
      filter.init([
        meta({ name: 'gmail', domains: ['mail.google.com', 'gmail.com'] }),
        meta({ name: 'always' }),
      ]);
      // After init alone, conditional skills are dormant.
      expect(filter.isAvailable('gmail')).toBe(false);
      expect(filter.isAvailable('always')).toBe(true);

      // 3. Bootstrap replays the seed snapshot — fix path.
      const delta = filter.onActiveTabChange('gmail.com');
      expect(delta.activated).toEqual(['gmail']);
      expect(filter.isAvailable('gmail')).toBe(true);
    });

    it('replay with a now-stale snapshot leaves no skills active', () => {
      // 1. Early snapshot for gmail.com lands in empty filter.
      filter.onActiveTabChange('gmail.com');
      // 2. init populates the maps.
      filter.init([meta({ name: 'gmail', domains: ['gmail.com'] })]);
      // 3. By the time the bootstrap calls getCurrent(), the user has
      //    already navigated to github.com — so the replay value is github.
      const delta = filter.onActiveTabChange('github.com');
      expect(delta.activated).toEqual([]);
      expect(filter.isAvailable('gmail')).toBe(false);
    });
  });
});
