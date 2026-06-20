/**
 * Bounded Request Queue
 *
 * Enforces a global inbound-queue capacity (returning OVERLOADED when full) and
 * serializes conflicting requests by resource key (writes exclusive, reads
 * shared). A per-connection RPC gate prevents queued work from starting after
 * the connection closes.
 *
 * @module app-server/queue/RequestQueue
 */

import { overloaded, type ErrorShape } from '@workx/ws-server';
import type { ConnectionRpcGate } from '../connection/ConnectionRpcGate';
import type { RequestAccessMode } from './requestSerialization';

export interface QueuedRequest {
  connectionId: string;
  requestId: string;
  /** Serialization key (from resolveSerialization). */
  serialKey: string;
  mode: RequestAccessMode;
  /** RPC gate for the owning connection. */
  gate?: ConnectionRpcGate;
  /** The work to run. Rejections are surfaced to the caller of run(). */
  run: () => Promise<void>;
}

export interface RequestQueueOptions {
  capacity: number;
}

/**
 * Read/write lock per serialization key. Writes are exclusive; reads run
 * concurrently but never overtake a pending write, and a write waits for
 * in-flight reads to drain.
 */
class RWLock {
  private writeTail: Promise<void> = Promise.resolve();
  private activeReads = new Set<Promise<unknown>>();

  /**
   * Number of requests currently referencing this lock — in-flight OR queued.
   * The owning map entry must only be removed when this hits zero, otherwise a
   * still-queued request and a freshly-created replacement lock for the same
   * key could run concurrently and break serialization.
   */
  refs = 0;

  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.writeTail;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.writeTail = prior.then(() => gate);
    await prior;
    // Wait for any in-flight reads issued before this write to finish.
    await Promise.allSettled([...this.activeReads]);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async runRead<T>(fn: () => Promise<T>): Promise<T> {
    // Reads wait for pending writes, then run concurrently with each other.
    await this.writeTail;
    const p = fn();
    this.activeReads.add(p);
    try {
      return await p;
    } finally {
      this.activeReads.delete(p);
    }
  }
}

export class RequestQueue {
  private size = 0;
  private locks = new Map<string, RWLock>();
  private shuttingDown = false;

  constructor(private readonly opts: RequestQueueOptions) {}

  get inFlight(): number {
    return this.size;
  }

  /**
   * Enqueue a request. Returns immediately with an OVERLOADED error if the
   * queue is at capacity. Otherwise schedules the work and returns a promise
   * that resolves once the work has been attempted.
   *
   * Health/readiness checks should bypass the scheduler entirely.
   */
  enqueue(req: QueuedRequest): { accepted: boolean; error?: ErrorShape; done?: Promise<void> } {
    if (this.shuttingDown) {
      return { accepted: false, error: overloaded(500, 'Server shutting down') };
    }
    if (this.size >= this.opts.capacity) {
      return { accepted: false, error: overloaded() };
    }

    this.size += 1;
    const done = this.dispatch(req).finally(() => {
      this.size -= 1;
    });
    return { accepted: true, done };
  }

  private async dispatch(req: QueuedRequest): Promise<void> {
    const guarded = async (): Promise<void> => {
      // Drop work whose connection closed while queued.
      if (req.gate && !req.gate.tryEnter()) return;
      try {
        await req.run();
      } finally {
        req.gate?.release();
      }
    };

    if (req.serialKey === 'none') {
      await guarded();
      return;
    }

    let lock = this.locks.get(req.serialKey);
    if (!lock) {
      lock = new RWLock();
      this.locks.set(req.serialKey, lock);
    }

    // Reference the lock for the whole queued+running lifetime so a concurrent
    // same-key request always shares THIS lock. Only drop the map entry once no
    // request references it — deleting earlier (e.g. while a write is still
    // queued) would let a replacement lock run concurrently and break
    // serialization.
    lock.refs += 1;
    try {
      if (req.mode === 'write') {
        await lock.runWrite(guarded);
      } else {
        await lock.runRead(guarded);
      }
    } finally {
      lock.refs -= 1;
      if (lock.refs === 0 && this.locks.get(req.serialKey) === lock) {
        this.locks.delete(req.serialKey);
      }
    }
  }

  async shutdown(_reason: string): Promise<void> {
    this.shuttingDown = true;
    this.locks.clear();
  }
}
