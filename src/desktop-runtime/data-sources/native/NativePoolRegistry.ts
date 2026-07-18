export interface NativePoolEntry<TPool> {
  connectionRevision: number;
  pool: TPool;
}

export class NativePoolRegistry<TPool> {
  private readonly pools = new Map<string, NativePoolEntry<TPool>>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private disposing = false;

  constructor(private readonly closePool: (pool: TPool) => Promise<void>) {}

  async getOrCreate(
    sourceId: string,
    connectionRevision: number,
    factory: () => Promise<TPool>
  ): Promise<TPool> {
    if (this.disposing) throw new Error('Data-source pool registry is stopping.');
    return this.serialized(sourceId, async () => {
      if (this.disposing) throw new Error('Data-source pool registry is stopping.');
      const existing = this.pools.get(sourceId);
      if (existing?.connectionRevision === connectionRevision) return existing.pool;
      if (existing) {
        this.pools.delete(sourceId);
        await this.closePool(existing.pool);
      }
      const pool = await factory();
      if (this.disposing) {
        await this.closePool(pool);
        throw new Error('Data-source pool registry is stopping.');
      }
      this.pools.set(sourceId, { connectionRevision, pool });
      return pool;
    });
  }

  async invalidate(sourceId: string): Promise<void> {
    await this.serialized(sourceId, async () => {
      const existing = this.pools.get(sourceId);
      if (!existing) return;
      this.pools.delete(sourceId);
      await this.closePool(existing.pool);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const sourceIds = new Set([...this.pools.keys(), ...this.operationTails.keys()]);
    await Promise.allSettled(
      [...sourceIds].map((sourceId) =>
        this.serialized(sourceId, async () => {
          const existing = this.pools.get(sourceId);
          if (!existing) return;
          this.pools.delete(sourceId);
          await this.closePool(existing.pool);
        })
      )
    );
  }

  private async serialized<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.operationTails.set(sourceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(sourceId) === tail) {
        await tail;
        this.operationTails.delete(sourceId);
      }
    }
  }
}
