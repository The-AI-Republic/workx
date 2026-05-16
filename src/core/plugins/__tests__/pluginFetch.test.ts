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

  // ── Pinned-sha path (review B: supply-chain fail-open fix) ──────────

  it('pinned sha: clone (no --branch) then fetch + detach-checkout the sha', async () => {
    const sha = 'b'.repeat(40);
    const d = deps({ resolveHeadSha: vi.fn(async () => sha) });
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      name: 'gh',
      source: { type: 'github', repo: 'browserx/gh', sha },
      version: '1.0.0',
    }));
    const result = await fetchPlugin('gh@official');

    expect(d.run).toHaveBeenCalledTimes(3);
    const calls = (d.run.mock.calls as unknown as [string[]][]).map((c) => c[0]);
    expect(calls[0]).toContain('clone');
    expect(calls[0]).not.toContain('--branch'); // a raw sha is NOT a branch
    expect(calls[1]).toEqual(expect.arrayContaining(['fetch', '--depth', '1', 'origin', sha]));
    expect(calls[2]).toEqual(expect.arrayContaining(['checkout', '--detach', sha]));
    expect(result.gitCommitSha).toBe(sha);
  });

  it('pinned sha is verified by construction even if rev-parse HEAD fails', async () => {
    const sha = 'c'.repeat(40);
    const d = deps({ resolveHeadSha: vi.fn(async () => undefined) });
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      name: 'gh',
      source: { type: 'github', repo: 'x/gh', sha },
      version: '1',
    }));
    const result = await fetchPlugin('gh@official');
    // Old code returned undefined here → installer fail-open. Now: the sha.
    expect(result.gitCommitSha).toBe(sha);
  });

  it('pinned sha: aborts (fail-closed) when post-checkout HEAD disagrees', async () => {
    const sha = 'd'.repeat(40);
    const d = deps({ resolveHeadSha: vi.fn(async () => 'e'.repeat(40)) });
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      name: 'gh',
      source: { type: 'github', repo: 'x/gh', sha },
      version: '1',
    }));
    await expect(fetchPlugin('gh@official')).rejects.toThrow(/post-checkout sha mismatch/);
    expect(d.removeDir).toHaveBeenCalledWith('/tmp/clone');
  });

  it('pinned sha: a failed fetch aborts (fail-closed), nothing returned', async () => {
    const sha = 'f'.repeat(40);
    const d = deps({
      run: vi.fn(async (args: string[]) =>
        args.includes('fetch')
          ? { code: 1, stdout: '', stderr: 'fatal: no such object' }
          : { code: 0, stdout: '', stderr: '' },
      ),
    });
    const fetchPlugin = createGitFetchPlugin(d, () => ({
      name: 'gh',
      source: { type: 'github', repo: 'x/gh', sha },
      version: '1',
    }));
    await expect(fetchPlugin('gh@official')).rejects.toThrow(/git fetch .* failed/);
    expect(d.removeDir).toHaveBeenCalledWith('/tmp/clone');
  });
});
