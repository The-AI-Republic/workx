import type { EventDispatcher } from '../RepublicAgent';
import type { Event } from '../protocol/types';

export interface ReplayCursor {
  runtimeEpoch: string;
  eventSeq: number;
}

export interface SequencedSessionEvent {
  runtimeEpoch: string;
  eventSeq: number;
  event: Event;
}

export interface ReplayBatch {
  runtimeEpoch: string;
  baseRolloutRevision: number;
  firstSeq: number;
  throughSeq: number;
  truncated: boolean;
  events: SequencedSessionEvent[];
}

/** Buffers initialization events, then becomes the synchronous event chokepoint. */
export class SwitchableEventGate {
  readonly dispatcher: EventDispatcher;
  private state: 'buffering' | 'active' | 'closed' = 'buffering';
  private readonly pending: Event[] = [];
  private pendingBytes = 0;
  private truncated = false;
  private readonly runtimeEpoch = crypto.randomUUID();
  private nextSeq = 1;
  private readonly ring: SequencedSessionEvent[] = [];
  private ringBytes = 0;
  private baseRolloutRevision = 0;
  private outboundTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly destination: EventDispatcher,
    private readonly maxEvents = 512,
    private readonly maxBytes = 1024 * 1024,
  ) {
    this.dispatcher = (event) => this.capture(event);
  }

  activate(): void {
    if (this.state !== 'buffering') return;
    this.state = 'active';
    const buffered = this.pending.splice(0);
    this.pendingBytes = 0;
    for (const event of buffered) this.enqueueActive(event);
  }

  close(): void {
    this.state = 'closed';
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  currentCursor(): ReplayCursor {
    return { runtimeEpoch: this.runtimeEpoch, eventSeq: this.nextSeq - 1 };
  }

  replay(cursor?: ReplayCursor, throughSeq = this.nextSeq - 1): ReplayBatch | null {
    if (cursor && cursor.runtimeEpoch !== this.runtimeEpoch) return null;
    const firstAvailableSeq = this.ring[0]?.eventSeq ?? this.nextSeq;
    const events = cursor
      ? this.ring.filter((item) => item.eventSeq > cursor.eventSeq && item.eventSeq <= throughSeq)
      : this.ring.filter((item) => item.eventSeq <= throughSeq);
    return {
      runtimeEpoch: this.runtimeEpoch,
      baseRolloutRevision: this.baseRolloutRevision,
      firstSeq: events[0]?.eventSeq ?? this.nextSeq,
      throughSeq,
      truncated: cursor
        ? cursor.eventSeq < firstAvailableSeq - 1
        : this.truncated,
      events,
    };
  }

  async flush(): Promise<void> {
    await this.outboundTail;
  }

  setBaseRolloutRevision(revision: number): void {
    this.baseRolloutRevision = revision;
  }

  clearReplay(baseRolloutRevision = this.baseRolloutRevision): void {
    this.baseRolloutRevision = baseRolloutRevision;
    this.ring.length = 0;
    this.ringBytes = 0;
    this.truncated = false;
  }

  private capture(event: Event): void {
    if (this.state === 'closed') return;
    if (this.state === 'buffering') {
      const bytes = byteLength(event);
      while (
        this.pending.length > 0
        && (this.pending.length >= this.maxEvents || this.pendingBytes + bytes > this.maxBytes)
      ) {
        const dropped = this.pending.shift()!;
        this.pendingBytes -= byteLength(dropped);
        this.truncated = true;
      }
      if (bytes > this.maxBytes) {
        this.truncated = true;
        return;
      }
      this.pending.push(event);
      this.pendingBytes += bytes;
      return;
    }
    this.enqueueActive(event);
  }

  private enqueueActive(event: Event): void {
    const sequenced: SequencedSessionEvent = {
      runtimeEpoch: this.runtimeEpoch,
      eventSeq: this.nextSeq++,
      event,
    };
    const bytes = byteLength(sequenced);
    this.ring.push(sequenced);
    this.ringBytes += bytes;
    while (this.ring.length > this.maxEvents || this.ringBytes > this.maxBytes) {
      const dropped = this.ring.shift()!;
      this.ringBytes -= byteLength(dropped);
      this.truncated = true;
    }
    this.outboundTail = this.outboundTail
      .catch(() => undefined)
      .then(() => Promise.resolve(this.destination({
        ...event,
        runtimeEpoch: sequenced.runtimeEpoch,
        eventSeq: sequenced.eventSeq,
      })).then(() => undefined))
      .catch((error) => {
        console.warn('[SwitchableEventGate] outbound delivery failed:', error);
      });
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
