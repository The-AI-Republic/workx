import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sweepToolResults, DEFAULT_TOOL_RESULT_TTL_DAYS } from '../toolResultCleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

async function setMtime(file: string, daysAgo: number): Promise<void> {
  const t = new Date(Date.now() - daysAgo * DAY_MS);
  await utimes(file, t, t);
}

describe('sweepToolResults', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'browserx-toolsweep-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function seed(sessionId: string, name: string, daysAgo: number): Promise<string> {
    const dir = join(dataDir, 'sessions', sessionId, 'tool-results');
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, 'data');
    await setMtime(file, daysAgo);
    return file;
  }

  it('deletes files older than the TTL by mtime', async () => {
    const old = await seed('sessA', 'old.txt', 45);
    const fresh = await seed('sessA', 'fresh.txt', 1);

    const n = await sweepToolResults(dataDir, DEFAULT_TOOL_RESULT_TTL_DAYS);
    expect(n).toBe(1);

    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(fresh)).resolves.toBeDefined();
  });

  it('processes multiple session directories', async () => {
    await seed('sessA', 'old.txt', 60);
    await seed('sessB', 'old.txt', 60);
    await seed('sessC', 'fresh.txt', 5);
    const n = await sweepToolResults(dataDir, 30);
    expect(n).toBe(2);
  });

  it('does not remove the session directory itself', async () => {
    await seed('sessA', 'old.txt', 60);
    await sweepToolResults(dataDir, 30);
    const stillThere = await readdir(join(dataDir, 'sessions'));
    expect(stillThere).toContain('sessA');
  });

  it('returns 0 with no sessions directory (cold start)', async () => {
    const n = await sweepToolResults(dataDir, 30);
    expect(n).toBe(0);
  });

  it('ignores sessions without a tool-results subdirectory', async () => {
    await mkdir(join(dataDir, 'sessions', 'noTools'), { recursive: true });
    const n = await sweepToolResults(dataDir, 30);
    expect(n).toBe(0);
  });

  it('honors a custom ttlDays', async () => {
    await seed('sessA', 'twoDays.txt', 2);
    // ttl 1 day → twoDays.txt is stale.
    expect(await sweepToolResults(dataDir, 1)).toBe(1);
  });
});
