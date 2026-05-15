import { describe, it, expect, beforeEach } from 'vitest';
import type { FileSystem } from '../../memory/types';
import {
  SessionSummaryFileStore,
  getSessionSummaryPath,
  isSessionSummaryEmpty,
} from '../SessionSummaryFileStore';
import { SESSION_SUMMARY_TEMPLATE } from '../template';

class InMemoryFs implements FileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async readFile(path: string): Promise<string> {
    if (!this.files.has(path)) throw new Error('ENOENT');
    return this.files.get(path)!;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

describe('SessionSummaryFileStore', () => {
  const memoryRoot = '/tmp/memory';
  const sessionId = 's1';
  let fs: InMemoryFs;
  let store: SessionSummaryFileStore;

  beforeEach(() => {
    fs = new InMemoryFs();
    store = new SessionSummaryFileStore(fs, memoryRoot);
  });

  it('pathFor produces sessions/<sid>/summary.md under memoryRoot', () => {
    expect(store.pathFor(sessionId)).toBe(
      getSessionSummaryPath(memoryRoot, sessionId),
    );
    expect(store.pathFor(sessionId)).toMatch(/sessions[/\\]s1[/\\]summary\.md$/);
  });

  it('ensureScaffold writes the template on first call', async () => {
    const file = await store.ensureScaffold(sessionId);
    expect(fs.files.get(file)).toBe(SESSION_SUMMARY_TEMPLATE);
    expect(fs.dirs.size).toBeGreaterThan(0);
  });

  it('ensureScaffold is idempotent — second call preserves existing edits', async () => {
    await store.ensureScaffold(sessionId);
    const file = store.pathFor(sessionId);
    // Simulate the extractor having edited the file.
    fs.files.set(file, SESSION_SUMMARY_TEMPLATE + '\nCustom content under section\n');

    await store.ensureScaffold(sessionId);

    expect(fs.files.get(file)).toContain('Custom content under section');
  });

  it('read returns "" when the file is missing', async () => {
    expect(await store.read(sessionId)).toBe('');
  });

  it('read returns the current content when present', async () => {
    await store.ensureScaffold(sessionId);
    fs.files.set(store.pathFor(sessionId), 'hello');
    expect(await store.read(sessionId)).toBe('hello');
  });
});

describe('isSessionSummaryEmpty', () => {
  it('is empty for an empty string', () => {
    expect(isSessionSummaryEmpty('')).toBe(true);
  });

  it('is empty for the canonical template', () => {
    expect(isSessionSummaryEmpty(SESSION_SUMMARY_TEMPLATE)).toBe(true);
  });

  it('is empty for the template with trailing whitespace differences', () => {
    expect(isSessionSummaryEmpty(SESSION_SUMMARY_TEMPLATE + '\n\n  ')).toBe(true);
  });

  it('is not empty once the extractor has added content under a section', () => {
    const edited =
      SESSION_SUMMARY_TEMPLATE.replace(
        '_URLs the agent navigated to during this session._',
        '_URLs the agent navigated to during this session._\n- example.com',
      );
    expect(isSessionSummaryEmpty(edited)).toBe(false);
  });
});
