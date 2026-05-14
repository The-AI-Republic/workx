/**
 * TaskOutputStore — chunked, append-only output log for background tasks.
 *
 * Backing storage: `task_output_chunks` store (IndexedDB / SQLite via
 * the StorageAdapter abstraction). Each row holds a single chunk with a
 * monotonic per-task `seq`.
 *
 * The store is a write-time fan-out + read-time delta path:
 * - `appendChunk` queues writes per-task and drains via the adapter.
 * - `getDelta` returns chunks newer than `fromSeq` via `[taskId, seq]` range.
 *
 * v1 is foreground-skipped: only background sub-agent tasks write chunks
 * (see design.md Q3). Foreground task output stays in the conversation
 * message stream the user already sees.
 */

import type { StorageAdapter } from '../../storage/StorageAdapter';
import { TASK_OUTPUT_CHUNK_MAX_BYTES } from './timing';

export type TaskOutputChunkKind = 'stdout' | 'stderr' | 'event' | 'message';

export interface TaskOutputChunk {
  /** `${taskId}:${seq.toString().padStart(8, '0')}` — lex-sortable PK */
  chunkId: string;
  taskId: string;
  /** Monotonic per-task; consecutive on split-payload writes */
  seq: number;
  createdAt: number;
  kind: TaskOutputChunkKind;
  /** UTF-8, ≤ TASK_OUTPUT_CHUNK_MAX_BYTES; larger payloads split */
  data: string;
}

const STORE_NAME = 'task_output_chunks';

/** Format the lex-sortable chunkId from taskId + seq. */
function chunkIdFor(taskId: string, seq: number): string {
  return `${taskId}:${seq.toString().padStart(8, '0')}`;
}

interface QueuedWrite {
  kind: TaskOutputChunkKind;
  data: string;
  resolve: (chunk: TaskOutputChunk) => void;
  reject: (err: Error) => void;
}

/**
 * Append-only chunk store. Per-task in-memory queue drains via the adapter
 * so callers don't block on storage I/O. Sequence numbers are assigned
 * monotonically per task at drain time.
 */
export class TaskOutputStore {
  private adapter: StorageAdapter;
  /** Last seq written for each task. Populated lazily on first append. */
  private lastSeq = new Map<string, number>();
  /** Pending writes per task — drained sequentially per task. */
  private queues = new Map<string, QueuedWrite[]>();
  /** Per-task drain flight flag. */
  private draining = new Set<string>();
  /** lastReadAt heartbeat per task — used by TaskOutputManager eviction grace. */
  private lastReadAt = new Map<string, number>();

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  /**
   * Append a chunk. Resolves once the chunk is persisted. The returned
   * chunk has the assigned `seq` and `chunkId`. Payloads larger than
   * TASK_OUTPUT_CHUNK_MAX_BYTES are split into multiple consecutive
   * chunks; the last is returned.
   */
  async appendChunk(
    taskId: string,
    kind: TaskOutputChunkKind,
    data: string,
  ): Promise<TaskOutputChunk> {
    // Split oversized payloads into adjacent chunks.
    if (utf8ByteLength(data) > TASK_OUTPUT_CHUNK_MAX_BYTES) {
      const parts = splitUtf8(data, TASK_OUTPUT_CHUNK_MAX_BYTES);
      let last: TaskOutputChunk | null = null;
      for (const part of parts) {
        last = await this.enqueueOne(taskId, kind, part);
      }
      // splitUtf8 guarantees parts.length >= 1 since data was non-empty enough
      // to exceed the threshold.
      return last!;
    }
    return this.enqueueOne(taskId, kind, data);
  }

  /** Get all chunks with `seq > fromSeq`, ordered. */
  async getDelta(taskId: string, fromSeq = 0): Promise<TaskOutputChunk[]> {
    this.lastReadAt.set(taskId, Date.now());
    // `[taskId, seq]` IDBKeyRange.bound(lower-exclusive, upper-unbounded)
    const lower: [string, number] = [taskId, fromSeq];
    // Upper bound: same taskId, +infinity seq. IDB supports open-ended
    // upper bounds via a sentinel taskId greater than any seq we'd write,
    // so use [taskId, Number.MAX_SAFE_INTEGER] as the upper bound.
    const upper: [string, number] = [taskId, Number.MAX_SAFE_INTEGER];
    const range = IDBKeyRange.bound(lower, upper, /* lowerOpen */ true, false);
    const rows = await this.adapter.queryByIndex<TaskOutputChunk>(
      STORE_NAME,
      'by_task_seq',
      range,
    );
    // Adapter may not guarantee order across all implementations; sort to be safe.
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  }

  /**
   * AsyncIterable wrapper for delta polling. Resolves a fresh getDelta()
   * every `intervalMs`; consumer should call `return()` to stop.
   */
  async *streamDelta(
    taskId: string,
    fromSeq = 0,
    intervalMs: number,
  ): AsyncIterable<TaskOutputChunk[]> {
    let cursor = fromSeq;
    while (true) {
      const chunks = await this.getDelta(taskId, cursor);
      if (chunks.length > 0) {
        cursor = chunks[chunks.length - 1]!.seq;
        yield chunks;
      }
      await sleep(intervalMs);
    }
  }

  /** Delete every chunk for a task. Called by the eviction timer. */
  async cleanupTask(taskId: string): Promise<void> {
    const rows = await this.adapter.queryByIndex<TaskOutputChunk>(
      STORE_NAME,
      'by_task_id',
      taskId,
    );
    if (rows.length === 0) {
      this.lastSeq.delete(taskId);
      this.lastReadAt.delete(taskId);
      return;
    }
    const keys = rows.map(r => r.chunkId);
    await this.adapter.batchDelete(STORE_NAME, keys);
    this.lastSeq.delete(taskId);
    this.lastReadAt.delete(taskId);
  }

  /**
   * Bulk delete by joining with a known taskId set (typically a snapshot
   * of Session.activeTasks at shutdown time). Used by Session.dispose.
   */
  async cleanupSession(taskIds: string[]): Promise<void> {
    await Promise.all(taskIds.map(id => this.cleanupTask(id)));
  }

  /** Drain any pending in-memory writes for this task. */
  async flush(taskId: string): Promise<void> {
    const queue = this.queues.get(taskId);
    if (!queue || queue.length === 0) return;
    if (this.draining.has(taskId)) {
      // Wait briefly for in-flight drain to complete.
      while (this.draining.has(taskId)) {
        await sleep(5);
      }
    }
    // After waiting, kick off another drain if anything new arrived.
    if (queue.length > 0) {
      await this.drainQueue(taskId);
    }
  }

  /** Test/debug: read the last heartbeat for a task (for eviction grace). */
  getLastReadAt(taskId: string): number | undefined {
    return this.lastReadAt.get(taskId);
  }

  // ─── internals ───────────────────────────────────────────────────────

  private enqueueOne(
    taskId: string,
    kind: TaskOutputChunkKind,
    data: string,
  ): Promise<TaskOutputChunk> {
    return new Promise<TaskOutputChunk>((resolve, reject) => {
      const queue = this.queues.get(taskId) ?? [];
      queue.push({ kind, data, resolve, reject });
      this.queues.set(taskId, queue);
      void this.drainQueue(taskId);
    });
  }

  private async drainQueue(taskId: string): Promise<void> {
    if (this.draining.has(taskId)) return;
    this.draining.add(taskId);
    try {
      while (true) {
        const queue = this.queues.get(taskId);
        if (!queue || queue.length === 0) break;

        // Resolve lastSeq lazily — read existing chunks if we don't know.
        let lastSeq = this.lastSeq.get(taskId);
        if (lastSeq === undefined) {
          const existing = await this.adapter.queryByIndex<TaskOutputChunk>(
            STORE_NAME,
            'by_task_id',
            taskId,
          );
          lastSeq = existing.reduce(
            (max, r) => (r.seq > max ? r.seq : max),
            0,
          );
          this.lastSeq.set(taskId, lastSeq);
        }

        const next = queue.shift()!;
        const seq = lastSeq + 1;
        const chunk: TaskOutputChunk = {
          chunkId: chunkIdFor(taskId, seq),
          taskId,
          seq,
          createdAt: Date.now(),
          kind: next.kind,
          data: next.data,
        };
        try {
          await this.adapter.put<TaskOutputChunk>(STORE_NAME, chunk);
          this.lastSeq.set(taskId, seq);
          next.resolve(chunk);
        } catch (err) {
          next.reject(err instanceof Error ? err : new Error(String(err)));
          // Don't update lastSeq on failure — next attempt retries the same seq.
        }
      }
    } finally {
      this.draining.delete(taskId);
    }
  }
}

// ─── utilities ──────────────────────────────────────────────────────────

function utf8ByteLength(s: string): number {
  // TextEncoder is available in extension, worker, Node 11+.
  return new TextEncoder().encode(s).length;
}

/**
 * Split a string into parts each ≤ maxBytes when encoded as UTF-8. Splits
 * on code-point boundaries (never mid-surrogate). Slow path acceptable for
 * the rare oversize-payload case.
 */
function splitUtf8(s: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let buf = '';
  let bufBytes = 0;
  for (const ch of s) {
    const chBytes = encoder.encode(ch).length;
    if (bufBytes + chBytes > maxBytes && buf.length > 0) {
      parts.push(buf);
      buf = '';
      bufBytes = 0;
    }
    buf += ch;
    bufBytes += chBytes;
  }
  if (buf.length > 0) parts.push(buf);
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
