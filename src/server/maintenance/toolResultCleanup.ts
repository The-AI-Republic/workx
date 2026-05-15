/**
 * Server-mode TTL sweep for persisted tool results (track 09).
 *
 * Session.close() handles in-flight cleanup, but crashed servers can leave
 * orphaned `tool-results/` directories. This periodic walker removes files
 * older than the configured TTL by mtime.
 *
 * The sweep is intentionally simple: walk `{dataDir}/sessions/{*}/tool-results/`,
 * `unlink` stale files, and do not remove session directories (other
 * subsystems may use them).
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_TOOL_RESULT_TTL_DAYS = 30;

/**
 * One-shot sweep of `{dataDir}/sessions/*\/tool-results/*` removing files
 * older than `ttlDays` by mtime. Returns the number of files deleted.
 *
 * Failures inside the walk are logged and swallowed — one bad session must
 * not prevent the others from being cleaned.
 */
export async function sweepToolResults(
  dataDir: string,
  ttlDays: number = DEFAULT_TOOL_RESULT_TTL_DAYS,
): Promise<number> {
  const sessionsRoot = join(dataDir, 'sessions');
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  let sessions: string[];
  try {
    sessions = await readdir(sessionsRoot);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 0; // never ran yet — nothing to do
    console.warn('[toolResultCleanup] readdir sessions failed:', e);
    return 0;
  }

  for (const sessionId of sessions) {
    const dir = join(sessionsRoot, sessionId, 'tool-results');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        console.warn(`[toolResultCleanup] readdir ${dir} failed:`, e);
      }
      continue;
    }

    for (const name of entries) {
      const filepath = join(dir, name);
      try {
        const st = await stat(filepath);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          await unlink(filepath);
          deleted += 1;
        }
      } catch (e) {
        // File may have been removed concurrently — non-fatal.
        console.warn(`[toolResultCleanup] processing ${filepath} failed:`, e);
      }
    }
  }
  return deleted;
}

/**
 * Schedule periodic TTL sweeps. Returns a handle the caller can use to stop
 * the sweep on server shutdown.
 *
 * Default cadence is once per 24 hours — frequent enough to catch
 * accumulating cruft, infrequent enough that the walk cost is negligible.
 */
export function schedulePeriodicSweep(
  dataDir: string,
  opts: { ttlDays?: number; intervalMs?: number } = {},
): { stop: () => void } {
  const ttlDays = opts.ttlDays ?? DEFAULT_TOOL_RESULT_TTL_DAYS;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;

  // Kick off one sweep on schedule start so a long-running server doesn't
  // accumulate cruft just because nobody ever closes a session cleanly.
  void sweepToolResults(dataDir, ttlDays).catch((e) =>
    console.warn('[toolResultCleanup] initial sweep failed:', e),
  );

  const timer = setInterval(() => {
    void sweepToolResults(dataDir, ttlDays).catch((e) =>
      console.warn('[toolResultCleanup] periodic sweep failed:', e),
    );
  }, intervalMs);
  // Don't keep the process alive on its own just for this timer.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop: () => clearInterval(timer),
  };
}
