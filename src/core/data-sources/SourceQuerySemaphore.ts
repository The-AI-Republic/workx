import { DataSourceError } from './errors';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

export class SourceQuerySemaphore {
  private active = false;
  private readonly queue: Waiter[] = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new DataSourceError('QUERY_CANCELLED', 'Query was cancelled.');
    if (!this.active) {
      this.active = true;
      return this.release;
    }
    if (this.queue.length >= 4)
      throw new DataSourceError('QUERY_BUSY', 'This data source is busy.', true);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(
            new DataSourceError('QUERY_BUSY', 'Timed out waiting for this data source.', true)
          );
        }, 5_000),
      };
      waiter.abort = () => {
        this.remove(waiter);
        reject(new DataSourceError('QUERY_CANCELLED', 'Query was cancelled.'));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  cancelQueued(): void {
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(new DataSourceError('QUERY_CANCELLED', 'Query was cancelled.'));
    }
  }

  private readonly release = (): void => {
    const next = this.queue.shift();
    if (!next) {
      this.active = false;
      return;
    }
    clearTimeout(next.timer);
    if (next.abort) next.signal?.removeEventListener('abort', next.abort);
    next.resolve(this.release);
  };

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
  }
}
