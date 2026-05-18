/**
 * Track 10 security fix: plugin path jailing. Covers the traversal /
 * absolute-escape vectors the code review flagged (B1/B2 of PR #224).
 */

import { describe, it, expect } from 'vitest';
import {
  assertSafeRelPath,
  safeJoinUnderRoot,
  isSafeRelPath,
  PluginPathError,
} from '../pluginPath';

describe('assertSafeRelPath', () => {
  it('accepts and cleans normal relative paths', () => {
    expect(assertSafeRelPath('skills')).toBe('skills');
    expect(assertSafeRelPath('./skills/x/SKILL.md')).toBe('skills/x/SKILL.md');
    expect(assertSafeRelPath('a\\b\\c')).toBe('a/b/c');
    expect(assertSafeRelPath('a//b/./c')).toBe('a/b/c');
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafeRelPath('/etc')).toThrow(PluginPathError);
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/absolute/);
  });

  it('rejects drive-rooted (Windows) paths', () => {
    expect(() => assertSafeRelPath('C:/Windows')).toThrow(/drive-rooted/);
  });

  it('rejects home-relative (~) paths', () => {
    expect(() => assertSafeRelPath('~/.ssh/id_rsa')).toThrow(/home-relative/);
  });

  it('rejects any .. traversal segment', () => {
    expect(() => assertSafeRelPath('../etc')).toThrow(/traversal/);
    expect(() => assertSafeRelPath('a/../../b')).toThrow(/traversal/);
    expect(() => assertSafeRelPath('skills/../../../.ssh')).toThrow(/traversal/);
    expect(() => assertSafeRelPath('..')).toThrow(/traversal/);
  });

  it('rejects empty / non-string', () => {
    expect(() => assertSafeRelPath('')).toThrow(/non-empty/);
    // @ts-expect-error intentional
    expect(() => assertSafeRelPath(null)).toThrow(PluginPathError);
  });
});

describe('safeJoinUnderRoot', () => {
  it('joins a clean rel under root', () => {
    expect(safeJoinUnderRoot('/plugins/foo', 'skills')).toBe('/plugins/foo/skills');
    expect(safeJoinUnderRoot('/plugins/foo/', './a/b')).toBe('/plugins/foo/a/b');
  });

  it('empty-after-clean rel returns the root itself', () => {
    expect(safeJoinUnderRoot('/plugins/foo', './')).toBe('/plugins/foo');
  });

  it('rejects traversal + absolute before joining', () => {
    expect(() => safeJoinUnderRoot('/plugins/foo', '../../etc')).toThrow(/traversal/);
    expect(() => safeJoinUnderRoot('/plugins/foo', '/etc/passwd')).toThrow(/absolute/);
  });

  it('does not let a sibling-prefix root be escaped', () => {
    // ".../foo-evil" must not count as "under .../foo"
    const joined = safeJoinUnderRoot('/p/foo', 'x');
    expect(joined.startsWith('/p/foo/')).toBe(true);
  });
});

describe('isSafeRelPath', () => {
  it('predicate form mirrors assertSafeRelPath', () => {
    expect(isSafeRelPath('skills/x')).toBe(true);
    expect(isSafeRelPath('../escape')).toBe(false);
    expect(isSafeRelPath('/abs')).toBe(false);
  });
});
