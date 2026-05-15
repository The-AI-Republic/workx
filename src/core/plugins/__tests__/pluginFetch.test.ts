/**
 * Track 10b-finalize: createGitFetchPlugin — git-backed FetchedPlugin
 * builder. All I/O mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { createGitFetchPlugin } from '../pluginFetch';
import type { MarketplaceEntry } from '../MarketplaceSchema';

function deps(overrides = {}) {
  const fsmap: Record<string, string> = {
    'plugin.json': '{"name":"gh","version":"1.0.0"}',
    'skills/x/SKILL.md': 'body',
    '.git/config': 'should be excluded',
  };
  return {
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    mkTempDir: vi.fn(async () => '/tmp/clone'),
    walkFiles: vi.fn(async () => Object.keys(fsmap)),
    readBytes: vi.fn(async (p: string) =>
      new TextEncoder().encode(fsmap[p.replace('/tmp/clone/', '')] ?? ''),
    ),
    removeDir: vi.fn(async () => undefined),
    resolveHeadSha: vi.fn(async () => 'a'.repeat(40)),
    ...overrides,
  };
}

const ENTRY: MarketplaceEntry = {
  name: 'gh',
  source: { type: 'github', repo: 'browserx/gh' },
  version: '0.3.1',
};

describe('createGitFetchPlugin', () => {
  it('clones, walks files (excluding .git), returns FetchedPlugin', async () => {
    const d = deps();
    const fetchPlugin = createGitFetchPlugin(d, () => ENTRY);
    const result = await fetchPlugin('gh@official');

    expect(d.run).toHaveBeenCalledTimes(1);
    const cloneArgs = (d.run.mock.calls[0] as unknown as [string[]])[0];
    expect(cloneArgs).toContain('clone');
    expect(cloneArgs).toContain('--depth');

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['plugin.json', 'skills/x/SKILL.md']); // .git excluded
    expect(result.version).toBe('0.3.1'); // entry.version preferred
    expect(result.gitCommitSha).toBe('a'.repeat(40));
    expect(d.removeDir).toHaveBeenCalledWith('/tmp/clone'); // temp cleaned
  });

  it('falls back to short-sha version when entry has none', async () => {
    const d = deps();
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      ...ENTRY,
      version: undefined,
    }));
    const result = await fetchPlugin('gh@official');
    expect(result.version).toBe('aaaaaaa');
  });

  it('throws for unsupported source types', async () => {
    const d = deps();
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      name: 'gh',
      source: { type: 'path', path: '/x' },
    }));
    await expect(fetchPlugin('gh@official')).rejects.toThrow(/unsupported/);
  });

  it('cleans up the temp dir even when clone fails', async () => {
    const d = deps({
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' })),
    });
    const fetchPlugin = createGitFetchPlugin(d, () => ENTRY);
    await expect(fetchPlugin('gh@official')).rejects.toThrow();
    expect(d.removeDir).toHaveBeenCalledWith('/tmp/clone');
  });

  it('throws when no marketplace entry resolves', async () => {
    const d = deps();
    const fetchPlugin = createGitFetchPlugin(d, () => null);
    await expect(fetchPlugin('ghost@official')).rejects.toThrow(/no marketplace entry/);
  });
});
