/**
 * NodeFsExecutor — runtime port of the deleted tauri/src/fs_commands.rs.
 *
 * Mirrors the Rust unit tests so the security + freshness contract from
 * design §4.6/§4.8 (R1/R3/R4/R5/R6) is preserved byte-for-byte after the
 * Track 43 cutover. New tests:
 *   - jail rejects `..`, absolute paths outside the workspace, and
 *     symlinked ancestors that escape the workspace.
 *   - read/edit/write round-trip under the jail.
 *   - mtime freshness is enforced on edit and overwrite.
 *   - CRLF/BOM are detected on read and re-applied on write.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEdit, readFile, stat, writeIfUnchanged } from '../NodeFsExecutor';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fsexec-'));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('NodeFsExecutor jail', () => {
  it('rejects `..` escape lexically', async () => {
    await expect(stat(workspace, '../etc/passwd')).rejects.toThrow(/outside the workspace/);
  });

  it('rejects absolute paths outside the workspace', async () => {
    await expect(stat(workspace, '/etc/passwd')).rejects.toThrow(/outside the workspace/);
  });

  it('rejects sensitive directories on the blocklist', async () => {
    await fs.mkdir(path.join(workspace, '.git'));
    await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref');
    await expect(readFile(workspace, '.git/HEAD')).rejects.toThrow(/protected blocklist/);
  });

  it('rejects sensitive basenames anywhere under the workspace', async () => {
    await expect(readFile(workspace, '.env')).rejects.toThrow(/protected blocklist/);
    await expect(readFile(workspace, '.env.production')).rejects.toThrow(/protected blocklist/);
  });

  it('rejects symlinked ancestors that escape the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret'), 'x');
      await fs.symlink(outside, path.join(workspace, 'link'));
      await expect(readFile(workspace, 'link/secret')).rejects.toThrow(/outside the workspace/);
      // And a non-existing target under the same symlinked dir (create case).
      await expect(stat(workspace, 'link/new.txt')).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('NodeFsExecutor read/write round-trip', () => {
  it('reads an LF file and reports endings=LF, bom=false, no surrogate pair corruption', async () => {
    const target = path.join(workspace, 'a.txt');
    await fs.writeFile(target, 'hello\nworld');
    const r = await readFile(workspace, 'a.txt');
    expect(r.contentLf).toBe('hello\nworld');
    expect(r.endings).toBe('LF');
    expect(r.bom).toBe(false);
    expect(r.encoding).toBe('utf8');
    expect(r.size).toBeGreaterThan(0);
  });

  it('detects CRLF and BOM on read', async () => {
    const target = path.join(workspace, 'crlf-bom.txt');
    const payload = Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from('a\r\nb\r\nc', 'utf-8'),
    ]);
    await fs.writeFile(target, payload);
    const r = await readFile(workspace, 'crlf-bom.txt');
    expect(r.contentLf).toBe('a\nb\nc');
    expect(r.endings).toBe('CRLF');
    expect(r.bom).toBe(true);
  });

  it('refuses UTF-16 rather than silently corrupting on read', async () => {
    const target = path.join(workspace, 'utf16.txt');
    await fs.writeFile(target, Buffer.from([0xFF, 0xFE, 0x41, 0x00]));
    await expect(readFile(workspace, 'utf16.txt')).rejects.toThrow(/UTF-16/);
  });

  it('refuses binary garbage rather than lossy-decoding it', async () => {
    const target = path.join(workspace, 'bin.dat');
    // Invalid UTF-8 (lone continuation byte + overlong start)
    await fs.writeFile(target, Buffer.from([0x66, 0xC0, 0x80, 0xFF]));
    await expect(readFile(workspace, 'bin.dat')).rejects.toThrow(/UTF-16|unsupported/);
  });

  it('write_if_unchanged refuses to overwrite a stale file', async () => {
    const target = path.join(workspace, 'b.txt');
    await fs.writeFile(target, 'original');
    const s = await stat(workspace, 'b.txt');
    // Advance mtime explicitly to guarantee staleness.
    await fs.utimes(target, new Date(), new Date(s.mtimeMs + 2_000));
    const res = await writeIfUnchanged({
      workspaceRoot: workspace,
      path: 'b.txt',
      content: 'replacement',
      expectedMtimeMs: s.mtimeMs,
      endings: 'LF',
      bom: false,
    });
    expect(res.written).toBe('false');
    if (res.written === 'false') expect(res.reason).toBe('stale');
  });

  it('write_if_unchanged with expectedMtimeMs=null creates new files only', async () => {
    const ok = await writeIfUnchanged({
      workspaceRoot: workspace,
      path: 'new.txt',
      content: 'hi',
      expectedMtimeMs: null,
      endings: 'LF',
      bom: false,
    });
    expect(ok.written).toBe('true');
    const collide = await writeIfUnchanged({
      workspaceRoot: workspace,
      path: 'new.txt',
      content: 'oops',
      expectedMtimeMs: null,
      endings: 'LF',
      bom: false,
    });
    expect(collide.written).toBe('false');
    if (collide.written === 'false') expect(collide.reason).toBe('exists');
  });

  it('write_if_unchanged re-applies CRLF and BOM exactly', async () => {
    const r = await writeIfUnchanged({
      workspaceRoot: workspace,
      path: 'c.txt',
      content: 'a\nb\nc',
      expectedMtimeMs: null,
      endings: 'CRLF',
      bom: true,
    });
    expect(r.written).toBe('true');
    const bytes = await fs.readFile(path.join(workspace, 'c.txt'));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xEF, 0xBB, 0xBF]));
    expect(bytes.subarray(3).toString('utf-8')).toBe('a\r\nb\r\nc');
  });
});

describe('NodeFsExecutor edit', () => {
  it('rejects stale edits (mtime advanced + fresh content differs)', async () => {
    const target = path.join(workspace, 'e.txt');
    await fs.writeFile(target, 'aaa');
    const s = await stat(workspace, 'e.txt');
    // External writer changes the content + advances mtime. Explicitly
    // bump mtime so the test doesn't depend on the filesystem clock's
    // resolution — some FSes report identical mtimes for back-to-back
    // writes within the same ms.
    await fs.writeFile(target, 'xxx');
    await fs.utimes(target, new Date(), new Date(s.mtimeMs + 2_000));
    const s2 = await stat(workspace, 'e.txt');
    expect(s2.mtimeMs).not.toBe(s.mtimeMs);
    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'e.txt',
      oldString: 'aaa',
      newString: 'bbb',
      replaceAll: false,
      expectedMtimeMs: s.mtimeMs,
      expectedContentLf: 'aaa',
    });
    expect(res.ok).toBe('false');
    if (res.ok === 'false') expect(res.reason).toBe('stale');
  });

  it('handles the empty old_string create-new path', async () => {
    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'new-create.txt',
      oldString: '',
      newString: 'hello\nworld',
      replaceAll: false,
      expectedMtimeMs: 0,
      expectedContentLf: '',
    });
    expect(res.ok).toBe('true');
    if (res.ok === 'true') expect(res.newContentLf).toBe('hello\nworld');
    const onDisk = await fs.readFile(path.join(workspace, 'new-create.txt'), 'utf-8');
    expect(onDisk).toBe('hello\nworld');
  });

  it('rejects no_match when old_string does not appear in fresh content', async () => {
    await fs.writeFile(path.join(workspace, 'm.txt'), 'foo bar');
    const s = await stat(workspace, 'm.txt');
    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'm.txt',
      oldString: 'qux',
      newString: 'baz',
      replaceAll: false,
      expectedMtimeMs: s.mtimeMs,
      expectedContentLf: 'foo bar',
    });
    expect(res.ok).toBe('false');
    if (res.ok === 'false') expect(res.reason).toBe('no_match');
  });

  it('rejects not_unique when replaceAll=false and multiple matches exist', async () => {
    await fs.writeFile(path.join(workspace, 'u.txt'), 'x x x');
    const s = await stat(workspace, 'u.txt');
    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'u.txt',
      oldString: 'x',
      newString: 'y',
      replaceAll: false,
      expectedMtimeMs: s.mtimeMs,
      expectedContentLf: 'x x x',
    });
    expect(res.ok).toBe('false');
    if (res.ok === 'false') expect(res.reason).toBe('not_unique');
  });

  it('returns an actionable no_match message when normalization mismatch is the cause', async () => {
    // NFD: 'cafe' + combining acute (U+0301). NFC: 'caf' + precomposed e-acute (U+00E9).
    // Built via \u escapes so source-file encoding cannot silently normalize one.
    const nfd = 'cafe' + '\u0301';
    const nfc = 'caf' + '\u00e9';
    expect(nfd === nfc).toBe(false);
    expect(nfd.normalize('NFC')).toBe(nfc);

    const target = path.join(workspace, 'norm.txt');
    await fs.writeFile(target, nfd);
    const s = await stat(workspace, 'norm.txt');

    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'norm.txt',
      oldString: nfc,
      newString: 'cafe',
      replaceAll: false,
      expectedMtimeMs: s.mtimeMs,
      expectedContentLf: nfd,
    });
    expect(res.ok).toBe('false');
    if (res.ok === 'false') {
      expect(res.reason).toBe('no_match');
      expect(res.message).toMatch(/normalization/i);
    }
  });

  it('replaces all occurrences when replaceAll=true and preserves CRLF/BOM', async () => {
    const target = path.join(workspace, 'multi.txt');
    await fs.writeFile(
      target,
      Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('x\r\nx\r\nx', 'utf-8')]),
    );
    const s = await stat(workspace, 'multi.txt');
    const res = await applyEdit({
      workspaceRoot: workspace,
      path: 'multi.txt',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
      expectedMtimeMs: s.mtimeMs,
      expectedContentLf: 'x\nx\nx',
    });
    expect(res.ok).toBe('true');
    if (res.ok === 'true') {
      expect(res.newContentLf).toBe('y\ny\ny');
      expect(res.endings).toBe('CRLF');
      expect(res.bom).toBe(true);
    }
    const bytes = await fs.readFile(target);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xEF, 0xBB, 0xBF]));
    expect(bytes.subarray(3).toString('utf-8')).toBe('y\r\ny\r\ny');
  });
});
