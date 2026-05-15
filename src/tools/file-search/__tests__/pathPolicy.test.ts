import { describe, it, expect } from 'vitest';
import { lexicalPathCheck, isSensitivePath } from '../pathPolicy';

describe('isSensitivePath', () => {
  it('flags sensitive dirs anywhere in the path', () => {
    expect(isSensitivePath('src/.git/config')).toBe(true);
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('a/.vscode/x')).toBe(true);
  });
  it('flags sensitive basenames incl. .env*', () => {
    expect(isSensitivePath('settings.json')).toBe(true);
    expect(isSensitivePath('a/b/.env')).toBe(true);
    expect(isSensitivePath('a/.env.local')).toBe(true);
    expect(isSensitivePath('a/.gitconfig')).toBe(true);
  });
  it('passes ordinary code paths', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false);
    expect(isSensitivePath('lib/env.ts')).toBe(false); // not .env
  });
});

describe('lexicalPathCheck', () => {
  it('no workspace → no_workspace', () => {
    expect(lexicalPathCheck(undefined, 'a.ts')).toEqual({ ok: false, reason: 'no_workspace' });
  });
  it('relative path resolves under root → ok', () => {
    const r = lexicalPathCheck('/w', 'src/a.ts');
    expect(r).toEqual({ ok: true, abs: '/w/src/a.ts' });
  });
  it('`..` escape → outside_workspace', () => {
    expect(lexicalPathCheck('/w', '../etc/passwd')).toEqual({ ok: false, reason: 'outside_workspace' });
  });
  it('absolute path outside root → outside_workspace', () => {
    expect(lexicalPathCheck('/w', '/etc/hosts')).toEqual({ ok: false, reason: 'outside_workspace' });
  });
  it('blocked sensitive path inside root → blocked', () => {
    expect(lexicalPathCheck('/w', '.git/config')).toEqual({ ok: false, reason: 'blocked' });
    expect(lexicalPathCheck('/w', 'sub/.env')).toEqual({ ok: false, reason: 'blocked' });
  });
});
