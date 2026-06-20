/**
 * Desktop telemetry sink — a size-capped rotating JSONL file under the
 * Tauri app log dir.
 *
 * DECISION (design task 3.3): no JS append API exists; the only generic
 * JS→disk write is the overwrite-only `skills_write_file` Tauri command.
 * Rotation is therefore done TS-side: a bounded in-memory ring of the most
 * recent lines is rewritten on a debounced flush. This caps file size
 * without a new Rust command. `write()` is sync and fire-and-forget; a
 * faulty flush can never reach the caller.
 */

import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { getLogPath } from '@/desktop/platform/paths';
import type { TelemetrySink, TelemetryEvent } from '@/core/telemetry';

const MAX_LINES = 2000;
const FLUSH_DEBOUNCE_MS = 5000;
const FILE_NAME = 'telemetry.jsonl';

const ring: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let resolvedPath: string | null = null;

async function pathOnce(): Promise<string> {
  if (resolvedPath) return resolvedPath;
  const dir = await getLogPath();
  try {
    await invoke('skills_ensure_dir', { path: dir });
  } catch {
    // best-effort; write will surface failure (and be swallowed)
  }
  resolvedPath = await join(dir, FILE_NAME);
  return resolvedPath;
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (ring.length === 0) return;
  try {
    const path = await pathOnce();
    await invoke('skills_write_file', {
      path,
      content: ring.join('\n') + '\n',
    });
  } catch {
    // telemetry must never break anything; drop on failure
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

export const FileSink: TelemetrySink = {
  write(event: TelemetryEvent) {
    try {
      ring.push(
        JSON.stringify({ t: Date.now(), n: event.name, m: event.metadata }),
      );
      if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
      scheduleFlush();
    } catch {
      // never propagate
    }
  },
};
