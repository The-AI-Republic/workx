/**
 * Track 10 security fix: git arg-injection (review B1 of PR #226) +
 * credential redaction (S4).
 */

import { describe, it, expect } from 'vitest';
import {
  buildCloneArgs,
  buildPullArgs,
  buildFetchShaArgs,
  buildCheckoutShaArgs,
  assertSafeGitSha,
  redactUrlCredentials,
  GitArgError,
} from '../git';

describe('buildCloneArgs — arg-injection guard', () => {
  it('builds a normal clone with -- separating options from the url', () => {
    const args = buildCloneArgs({ url: 'https://github.com/o/r.git', targetPath: '/tmp/x' });
    expect(args).toContain('clone');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(args[sep + 1]).toBe('https://github.com/o/r.git');
    expect(args[sep + 2]).toBe('/tmp/x');
  });

  it('rejects a url that starts with - (option smuggling)', () => {
    expect(() =>
      buildCloneArgs({ url: '--upload-pack=touch /tmp/pwned', targetPath: '/tmp/x' }),
    ).toThrow(GitArgError);
  });

  it('rejects disallowed url schemes (file://, ext::, etc.)', () => {
    expect(() => buildCloneArgs({ url: 'file:///etc', targetPath: '/t' })).toThrow(/scheme not allowed/);
    expect(() => buildCloneArgs({ url: 'ext::sh -c whoami', targetPath: '/t' })).toThrow(/scheme not allowed/);
  });

  it('accepts https / ssh / git / scp-style urls', () => {
    expect(() => buildCloneArgs({ url: 'https://h/r.git', targetPath: '/t' })).not.toThrow();
    expect(() => buildCloneArgs({ url: 'ssh://git@h/r.git', targetPath: '/t' })).not.toThrow();
    expect(() => buildCloneArgs({ url: 'git://h/r.git', targetPath: '/t' })).not.toThrow();
    expect(() => buildCloneArgs({ url: 'git@github.com:o/r.git', targetPath: '/t' })).not.toThrow();
  });

  it('rejects a ref that starts with - or contains .. / whitespace', () => {
    expect(() =>
      buildCloneArgs({ url: 'https://h/r.git', targetPath: '/t', ref: '--upload-pack=x' }),
    ).toThrow(GitArgError);
    expect(() =>
      buildCloneArgs({ url: 'https://h/r.git', targetPath: '/t', ref: 'a..b' }),
    ).toThrow(/invalid git ref/);
    expect(() =>
      buildCloneArgs({ url: 'https://h/r.git', targetPath: '/t', ref: 'a b' }),
    ).toThrow(/invalid git ref/);
  });

  it('buildPullArgs rejects a malicious ref', () => {
    expect(() => buildPullArgs('--upload-pack=x')).toThrow(GitArgError);
    expect(() => buildPullArgs('main')).not.toThrow();
  });
});

describe('pinned-sha args (review B: clone --branch <sha> never resolves)', () => {
  const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

  it('assertSafeGitSha accepts 40-hex, rejects everything else', () => {
    expect(() => assertSafeGitSha(SHA)).not.toThrow();
    expect(() => assertSafeGitSha('main')).toThrow(GitArgError);
    expect(() => assertSafeGitSha('A'.repeat(40))).toThrow(GitArgError); // uppercase
    expect(() => assertSafeGitSha('a'.repeat(39))).toThrow(GitArgError); // too short
    expect(() => assertSafeGitSha('--exec=x')).toThrow(GitArgError);
  });

  it('buildFetchShaArgs / buildCheckoutShaArgs build the exact safe args', () => {
    expect(buildFetchShaArgs(SHA)).toEqual(
      expect.arrayContaining(['fetch', '--depth', '1', 'origin', SHA]),
    );
    expect(buildCheckoutShaArgs(SHA)).toEqual(['checkout', '--detach', SHA]);
    // and they refuse a non-sha (no option-smuggling via the sha slot)
    expect(() => buildFetchShaArgs('--upload-pack=x')).toThrow(GitArgError);
    expect(() => buildCheckoutShaArgs('HEAD')).toThrow(GitArgError);
  });
});

describe('redactUrlCredentials', () => {
  it('redacts https/ssh/git scheme credentials', () => {
    expect(redactUrlCredentials('clone https://tok@github.com/o/r failed')).toBe(
      'clone https://***@github.com/o/r failed',
    );
    expect(redactUrlCredentials('ssh://user:pw@host/r')).toBe('ssh://***@host/r');
  });

  it('redacts scp-style user@host:path', () => {
    expect(redactUrlCredentials('git@github.com:o/r.git')).toBe('***@github.com:o/r.git');
  });
});
