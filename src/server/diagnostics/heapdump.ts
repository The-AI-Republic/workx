/**
 * Heap dump + memory diagnostics (Track 17) — SERVER ONLY (node `v8`/`fs`).
 *
 * Ported from claudy's `utils/heapDumpService.ts`, adapted to BrowserX:
 *   - writes under `{getDataDir()}/diagnostics/` (server dataDir / Track 09
 *     convention) — never `~/Desktop`, never the inert `getToolResultStore()`;
 *   - diagnostics JSON is written BEFORE the snapshot, because V8 snapshot
 *     serialization can OOM on a large heap — we still want the numbers;
 *   - the artifact reference is surfaced over `logs.tail` via `emitLog`.
 *
 * This module lives under `src/server/` so its node imports are never
 * bundled into the extension. It is reached only through an injected
 * `deps.heapdump` (see `core/services/diagnostics-services`), so `core/`
 * never imports it.
 *
 * @module server/diagnostics/heapdump
 */

import { createWriteStream } from 'fs';
import { mkdir, writeFile, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import {
  getHeapSnapshot,
  getHeapStatistics,
  getHeapSpaceStatistics,
} from 'v8';
import { getDataDir } from '@/server/config/server-config';
import { emitLog } from '../handlers/logs';

export interface HeapDumpResult {
  success: boolean;
  heapPath?: string;
  diagPath?: string;
  error?: string;
}

export interface MemoryDiagnostics {
  timestamp: string;
  uptimeSeconds: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    rss: number;
  };
  v8HeapStats: {
    heapSizeLimit: number;
    mallocedMemory: number;
    peakMallocedMemory: number;
    detachedContexts: number;
    nativeContexts: number;
  };
  v8HeapSpaces: Array<{
    name: string;
    size: number;
    used: number;
    available: number;
  }>;
  activeHandles: number;
  activeRequests: number;
  openFileDescriptors?: number;
  analysis: {
    potentialLeaks: string[];
    recommendation: string;
  };
  platform: string;
  nodeVersion: string;
}

/**
 * Capture memory diagnostics + a threshold leak heuristic. Cheap and
 * allocation-light so it can run before the (heavy) snapshot.
 */
export async function captureMemoryDiagnostics(): Promise<MemoryDiagnostics> {
  const usage = process.memoryUsage();
  const heapStats = getHeapStatistics();
  const uptimeSeconds = process.uptime();

  let heapSpaces: MemoryDiagnostics['v8HeapSpaces'] = [];
  try {
    heapSpaces = getHeapSpaceStatistics().map((s) => ({
      name: s.space_name,
      size: s.space_size,
      used: s.space_used_size,
      available: s.space_available_size,
    }));
  } catch {
    // Not available on every runtime.
  }

  const activeHandles = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.().length ?? 0;
  const activeRequests = (
    process as unknown as { _getActiveRequests?: () => unknown[] }
  )._getActiveRequests?.().length ?? 0;

  let openFileDescriptors: number | undefined;
  try {
    openFileDescriptors = (await readdir('/proc/self/fd')).length;
  } catch {
    // Not Linux / no procfs.
  }

  const nativeMemory = usage.rss - usage.heapUsed;
  const potentialLeaks: string[] = [];
  if (heapStats.number_of_detached_contexts > 0) {
    potentialLeaks.push(
      `${heapStats.number_of_detached_contexts} detached context(s) — possible context leak`,
    );
  }
  if (activeHandles > 100) {
    potentialLeaks.push(
      `${activeHandles} active handles — possible timer/socket leak`,
    );
  }
  if (nativeMemory > usage.heapUsed) {
    potentialLeaks.push(
      'Native memory > heap — leak may be in native addons',
    );
  }
  if (openFileDescriptors && openFileDescriptors > 500) {
    potentialLeaks.push(
      `${openFileDescriptors} open file descriptors — possible fd leak`,
    );
  }

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    memoryUsage: {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      rss: usage.rss,
    },
    v8HeapStats: {
      heapSizeLimit: heapStats.heap_size_limit,
      mallocedMemory: heapStats.malloced_memory,
      peakMallocedMemory: heapStats.peak_malloced_memory,
      detachedContexts: heapStats.number_of_detached_contexts,
      nativeContexts: heapStats.number_of_native_contexts,
    },
    v8HeapSpaces: heapSpaces,
    activeHandles,
    activeRequests,
    openFileDescriptors,
    analysis: {
      potentialLeaks,
      recommendation:
        potentialLeaks.length > 0
          ? `${potentialLeaks.length} potential leak indicator(s) — inspect the heap snapshot.`
          : 'No obvious leak indicators; inspect the heap snapshot for retained objects.',
    },
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/** The OOM-prone step, isolated so callers/tests can substitute it. */
export async function writeHeapSnapshot(filePath: string): Promise<void> {
  const writeStream = createWriteStream(filePath, { mode: 0o600 });
  await pipeline(getHeapSnapshot(), writeStream);
}

/**
 * Capture diagnostics + a V8 heap snapshot to `{dataDir}/diagnostics/`.
 * Diagnostics are written first (cheap, unlikely to fail); the snapshot is
 * streamed (it can crash on very large heaps — we still keep the JSON).
 *
 * `snapshotWriter` is injectable purely to isolate the OOM-prone step in
 * tests; production callers use the default.
 */
export async function performHeapDump(
  snapshotWriter: (filePath: string) => Promise<void> = writeHeapSnapshot,
): Promise<HeapDumpResult> {
  try {
    const diagnostics = await captureMemoryDiagnostics();

    const dumpDir = join(getDataDir(), 'diagnostics');
    await mkdir(dumpDir, { recursive: true });

    const stamp = `heapdump-${Date.now()}`;
    const heapPath = join(dumpDir, `${stamp}.heapsnapshot`);
    const diagPath = join(dumpDir, `${stamp}-diagnostics.json`);

    await writeFile(diagPath, JSON.stringify(diagnostics, null, 2), {
      mode: 0o600,
    });

    await snapshotWriter(heapPath);

    // Surface the artifact reference over logs.tail. The payload is only
    // file paths + a generated recommendation + counts — no secrets — so it
    // needs no redaction (the diagnostics JSON itself stays on disk).
    emitLog('info', '[heapdump] written', {
      artifact: {
        kind: 'heapdump',
        heapPath,
        diagPath,
        recommendation: diagnostics.analysis.recommendation,
      },
    });

    return { success: true, heapPath, diagPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitLog('error', `[heapdump] failed: ${message}`);
    return { success: false, error: message };
  }
}

/** Best-effort read of Linux smaps_rollup for the diagnostics consumer. */
export async function readSmapsRollup(): Promise<string | undefined> {
  try {
    return await readFile('/proc/self/smaps_rollup', 'utf8');
  } catch {
    return undefined;
  }
}
