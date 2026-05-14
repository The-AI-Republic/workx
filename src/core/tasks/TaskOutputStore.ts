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

/**
 * Append-only chunk store. Per-task in-memory queue drains via the adapter
 * so callers don't block on storage I/O. Sequence numbers are assigned
 * monotonically per task at drain time.
 */
export class TaskOutputStore {
  private adapter: StorageAdapter;
  /** Last seq written for each task. Populated lazily on first append. */
  private lastSeq = new Map<string, number>();
  /**
   * Per-task tail of a serialised write chain. Each enqueueOne extends the
   * tail so writes for the same task always happen in submission order.
   * `flush` awaits the current tail to know all pending writes are done.
   */
  private tails = new Map<string, Promise<void>>();
  /** lastReadAt heartbeat per task — used by TaskOutputManager eviction grace. */
  private lastReadAt = new Map<string, number>();
  /** Tasks that have been evicted; new appends are rejected. */
  private evicted = new Set<string>();

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

  /**
   * Delete every chunk for a task. Called by the eviction timer.
   *
   * (B1 fix) Marks the task evicted FIRST so any concurrent enqueueOne
   * rejects immediately, then waits for the current write-chain tail to
   * settle so any in-flight put() completes (or fails) before we delete
   * rows. After this, future appends for this task are rejected — see
   * the `evicted` guard in `enqueueOne`.
   */
  async cleanupTask(taskId: string): Promise<void> {
    // Block new appends.
    this.evicted.add(taskId);

    // Wait for the current write-chain tail to settle.
    const tail = this.tails.get(taskId);
    if (tail) {
      try {
        await tail;
      } catch {
        // Individual write failures surface via that write's own promise;
        // we tolerate them here.
      }
    }
    this.tails.delete(taskId);

    const rows = await this.adapter.queryByIndex<TaskOutputChunk>(
      STORE_NAME,
      'by_task_id',
      taskId,
    );
    if (rows.length > 0) {
      const keys = rows.map(r => r.chunkId);
      await this.adapter.batchDelete(STORE_NAME, keys);
    }
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

  /**
   * Wait until every write enqueued for this task so far has settled.
   *
   * (S4 fix) Awaits the current write-chain tail. Subsequent enqueueOne
   * calls extend the tail but do NOT extend this flush's wait — flush
   * sees the chain at the moment it's called, not future appends.
   */
  async flush(taskId: string): Promise<void> {
    const tail = this.tails.get(taskId);
    if (!tail) return;
    try {
      await tail;
    } catch {
      // Per-write failures are propagated through that write's own
      // promise; flush itself returns without throwing.
    }
  }

  /** Clear the evicted flag so a task id can be reused (tests/restart paths). */
  resetEvictedFlag(taskId: string): void {
    this.evicted.delete(taskId);
  }

  /** Test/debug: read the last heartbeat for a task (for eviction grace). */
  getLastReadAt(taskId: string): number | undefined {
    return this.lastReadAt.get(taskId);
  }

  // ─── internals ───────────────────────────────────────────────────────

  /**
   * Per-task serialised write chain. Each enqueueOne extends `tails[taskId]`
   * by chaining `.then(() => doWrite(...))`. This guarantees writes for the
   * same task happen in submission order without busy-polling, and flush
   * can await the current tail to know all currently-pending writes have
   * settled.
   */
  private enqueueOne(
    taskId: string,
    kind: TaskOutputChunkKind,
    data: string,
  ): Promise<TaskOutputChunk> {
    if (this.evicted.has(taskId)) {
      return Promise.reject(
        new Error(`TaskOutputStore: task ${taskId} has been evicted`),
      );
    }
    const prevTail = this.tails.get(taskId) ?? Promise.resolve();
    let resolve!: (c: TaskOutputChunk) => void;
    let reject!: (e: Error) => void;
    const writePromise = new Promise<TaskOutputChunk>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Chain the write onto the previous tail. The tail itself ignores
    // individual failures so one bad write doesn't poison the chain.
    const tail = prevTail.then(async () => {
      // Re-check eviction at write time — a cleanupTask may have run
      // between enqueue and execution.
      if (this.evicted.has(taskId)) {
        reject(new Error(`TaskOutputStore: task ${taskId} has been evicted`));
        return;
      }
      try {
        const chunk = await this.doWrite(taskId, kind, data);
        resolve(chunk);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.tails.set(taskId, tail);
    return writePromise;
  }

  /**
   * Execute a single put for the next seq. Resolves the seq lazily on
   * first write per task by querying existing rows.
   */
  private async doWrite(
    taskId: string,
    kind: TaskOutputChunkKind,
    data: string,
  ): Promise<TaskOutputChunk> {
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
    const seq = lastSeq + 1;
    const chunk: TaskOutputChunk = {
      chunkId: chunkIdFor(taskId, seq),
      taskId,
      seq,
      createdAt: Date.now(),
      kind,
      data,
    };
    await this.adapter.put<TaskOutputChunk>(STORE_NAME, chunk);
    this.lastSeq.set(taskId, seq);
    return chunk;
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
