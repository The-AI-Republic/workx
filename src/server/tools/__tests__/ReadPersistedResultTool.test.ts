/**
 * Tests for ReadPersistedResultTool (track 09).
 *
 * The security posture is the most important thing to verify here: path
 * traversal, escape via absolute path, and symlink-out-of-root must all be
 * rejected, even though those checks happen at runtime (not in the schema).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ReadPersistedResultTool,
  READ_PERSISTED_RESULT_MAX_BYTES,
} from '../ReadPersistedResultTool';

describe('ReadPersistedResultTool', () => {
  let parent: string;     // overall tmp parent (contains both root and outside-root files)
  let rootDir: string;    // tool's rootDir — only paths under here may be read
  let outsideFile: string;
  let tool: ReadPersistedResultTool;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'workx-rpr-'));
    rootDir = join(parent, 'root');
    await mkdir(rootDir, { recursive: true });

    // A file outside the root that should never be readable through the tool.
    outsideFile = join(parent, 'OUTSIDE-secret.txt');
    await writeFile(outsideFile, 'should-not-be-readable');

    tool = new ReadPersistedResultTool(rootDir);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function makePersistedFile(sessionId: string, name: string, content: string): Promise<string> {
    const dir = join(rootDir, sessionId, 'tool-results');
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, content);
    return file;
  }

  it('reads a persisted file under tool-results/', async () => {
    const file = await makePersistedFile('sess1', 'a.txt', 'hello');
    const got = await tool.execute({ path: file });
    expect(got).toBe('hello');
  });

  it('rejects absolute paths outside the root', async () => {
    await expect(tool.execute({ path: outsideFile })).rejects.toThrow(
      /outside the tool-results root|not under a tool-results directory/,
    );
  });

  it('rejects paths inside the root but not under tool-results/', async () => {
    const sessionMeta = join(rootDir, 'sess1', 'session-meta.json');
    await mkdir(join(rootDir, 'sess1'), { recursive: true });
    await writeFile(sessionMeta, '{}');
    await expect(tool.execute({ path: sessionMeta })).rejects.toThrow(
      /not under a tool-results directory/,
    );
  });

  it('rejects path-traversal attempts (..)', async () => {
    const file = await makePersistedFile('sess1', 'a.txt', 'hello');
    const traversed = join(file, '..', '..', '..', '..', 'OUTSIDE-secret.txt');
    // realpath will resolve this to outsideFile and the prefix check rejects.
    await expect(tool.execute({ path: traversed })).rejects.toThrow();
  });

  it('rejects symlinks that resolve outside the root', async () => {
    await makePersistedFile('sess1', 'a.txt', 'normal');
    // Create a symlink inside tool-results/ pointing at the outside file.
    const linkPath = join(rootDir, 'sess1', 'tool-results', 'evil.txt');
    await symlink(outsideFile, linkPath);
    await expect(tool.execute({ path: linkPath })).rejects.toThrow(
      /outside the tool-results root/,
    );
  });

  it('returns a descriptive ENOENT error', async () => {
    const missing = join(rootDir, 'sess1', 'tool-results', 'nope.txt');
    await expect(tool.execute({ path: missing })).rejects.toThrow(
      /may have been cleaned up/,
    );
  });

  it('rejects non-string path', async () => {
    await expect(tool.execute({ path: 42 as any })).rejects.toThrow(
      /must be a non-empty string/,
    );
  });

  it('rejects files larger than READ_PERSISTED_RESULT_MAX_BYTES', async () => {
    // Use truncate to make a sparse 50-MB-plus-1 file without allocating real disk.
    const { open } = await import('node:fs/promises');
    const dir = join(rootDir, 'sess1', 'tool-results');
    await mkdir(dir, { recursive: true });
    const big = join(dir, 'huge.txt');
    const fh = await open(big, 'w');
    try {
      await fh.truncate(READ_PERSISTED_RESULT_MAX_BYTES + 1);
    } finally {
      await fh.close();
    }
    await expect(tool.execute({ path: big })).rejects.toThrow(/exceeds the .* retrieval cap/);
  });

  it('canonicalizes the root via realpath (handles symlinked rootDir)', async () => {
    // Create a symlinked rootDir and re-construct the tool with that symlink.
    const linkedRoot = join(parent, 'root-link');
    await symlink(rootDir, linkedRoot);
    const linkedTool = new ReadPersistedResultTool(linkedRoot);
    const file = await makePersistedFile('sess2', 'a.txt', 'via-symlink-root');
    // Pass the realpath of the file (NOT the symlinked path) — the tool
    // should still accept it because both realpaths match.
    const real = await realpath(file);
    const got = await linkedTool.execute({ path: real });
    expect(got).toBe('via-symlink-root');
  });
});
