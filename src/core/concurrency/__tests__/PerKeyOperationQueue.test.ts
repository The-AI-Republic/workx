import { describe, expect, it, vi } from 'vitest';
import { PerKeyOperationQueue } from '../PerKeyOperationQueue';

describe('PerKeyOperationQueue', () => {
  it('serializes one key while allowing different keys to progress', async () => {
    const queue = new PerKeyOperationQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];

    const first = queue.run('a', async () => {
      order.push('a1:start');
      await blocked;
      order.push('a1:end');
    });
    const second = queue.run('a', async () => { order.push('a2'); });
    const other = queue.run('b', async () => { order.push('b1'); });

    await other;
    expect(order).toEqual(['a1:start', 'b1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
  });

  it('continues after rejection and flush waits for outstanding work', async () => {
    const queue = new PerKeyOperationQueue();
    const next = vi.fn();
    await expect(queue.run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    void queue.run('a', async () => { next(); });
    await queue.flush('a');
    expect(next).toHaveBeenCalledOnce();
  });
});
