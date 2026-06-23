import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DownloadWatcher, type DownloadEvent } from '../DownloadWatcher';

function installDownloadsMock() {
  const created: Array<(i: any) => void> = [];
  const changed: Array<(d: any) => void> = [];
  (globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    downloads: {
      onCreated: {
        addListener: (cb: any) => created.push(cb),
        removeListener: (cb: any) => {
          const i = created.indexOf(cb);
          if (i !== -1) created.splice(i, 1);
        },
      },
      onChanged: {
        addListener: (cb: any) => changed.push(cb),
        removeListener: (cb: any) => {
          const i = changed.indexOf(cb);
          if (i !== -1) changed.splice(i, 1);
        },
      },
    },
  };
  return {
    fireCreated: (item: any) => created.forEach((cb) => cb(item)),
    fireChanged: (delta: any) => changed.forEach((cb) => cb(delta)),
    listenerCounts: () => ({ created: created.length, changed: changed.length }),
  };
}

describe('DownloadWatcher', () => {
  let env: ReturnType<typeof installDownloadsMock>;
  let events: DownloadEvent[];
  let watcher: DownloadWatcher;

  beforeEach(() => {
    env = installDownloadsMock();
    events = [];
    watcher = new DownloadWatcher((e) => events.push(e));
  });

  it('emits started on creation and completed on state change', () => {
    watcher.start();
    env.fireCreated({ id: 1, filename: 'report.csv', url: 'https://x/r.csv', finalUrl: 'https://x/r.csv' });
    env.fireChanged({ id: 1, state: { previous: 'in_progress', current: 'complete' } });

    expect(events).toEqual([
      { id: 1, filename: 'report.csv', url: 'https://x/r.csv', status: 'started' },
      { id: 1, filename: 'report.csv', url: 'https://x/r.csv', status: 'completed' },
    ]);
  });

  it('tracks filename updates and emits interrupted', () => {
    watcher.start();
    env.fireCreated({ id: 2, filename: '', url: 'https://x/f' });
    env.fireChanged({ id: 2, filename: { current: '/downloads/final.pdf' } });
    env.fireChanged({ id: 2, state: { current: 'interrupted' } });

    expect(events[events.length - 1]).toEqual({
      id: 2,
      filename: '/downloads/final.pdf',
      url: 'https://x/f',
      status: 'interrupted',
    });
  });

  it('ignores events when stopped and removes listeners', () => {
    watcher.start();
    expect(env.listenerCounts()).toEqual({ created: 1, changed: 1 });
    watcher.stop();
    expect(env.listenerCounts()).toEqual({ created: 0, changed: 0 });
    env.fireCreated({ id: 3, filename: 'x', url: 'y' });
    expect(events).toHaveLength(0);
  });

  it('ignores onChanged for an untracked download', () => {
    watcher.start();
    env.fireChanged({ id: 99, state: { current: 'complete' } });
    expect(events).toHaveLength(0);
  });
});
