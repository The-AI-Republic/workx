import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChromeDebuggerSessionRegistry } from '../ChromeDebuggerSessionRegistry';

/**
 * Build a chrome.debugger mock and let the REAL ChromeDebuggerClient run against
 * it, so we exercise the registry end-to-end and can assert on attach/detach.
 */
function makeChromeEnv() {
  const detachListeners: Array<(source: any, reason: string) => void> = [];
  const runtime = { lastError: undefined as { message: string } | undefined };
  const attach = vi.fn((_debuggee: any, _version: string, cb: () => void) => cb());
  const detach = vi.fn((_debuggee: any, cb: () => void) => cb());
  const sendCommand = vi.fn((_debuggee: any, _method: string, _params: any, cb: (r: unknown) => void) =>
    cb({})
  );
  const chrome = {
    runtime,
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: {
        addListener: (cb: any) => detachListeners.push(cb),
        removeListener: (cb: any) => {
          const i = detachListeners.indexOf(cb);
          if (i !== -1) detachListeners.splice(i, 1);
        },
      },
    },
  };
  return { chrome, runtime, attach, detach, sendCommand, detachListeners };
}

describe('ChromeDebuggerSessionRegistry', () => {
  let registry: ChromeDebuggerSessionRegistry;
  let env: ReturnType<typeof makeChromeEnv>;

  beforeEach(() => {
    env = makeChromeEnv();
    (globalThis as any).chrome = env.chrome;
    registry = new ChromeDebuggerSessionRegistry();
  });

  afterEach(() => {
    registry._dispose();
  });

  it('attaches once for concurrent acquires on the same tab and detaches only at refcount 0', async () => {
    const [h1, h2] = await Promise.all([registry.acquire(1), registry.acquire(1)]);

    expect(env.attach).toHaveBeenCalledTimes(1);
    expect(registry.isAttached(1)).toBe(true);

    await h1.release();
    expect(env.detach).not.toHaveBeenCalled(); // h2 still holds a ref

    await h2.release();
    expect(env.detach).toHaveBeenCalledTimes(1);
    expect(registry.isAttached(1)).toBe(false);
  });

  it('attaches separately per tab', async () => {
    await registry.acquire(1);
    await registry.acquire(2);
    expect(env.attach).toHaveBeenCalledTimes(2);
    expect(registry.isAttached(1)).toBe(true);
    expect(registry.isAttached(2)).toBe(true);
  });

  it('release() is idempotent and never throws', async () => {
    const h = await registry.acquire(1);
    await h.release();
    await expect(h.release()).resolves.toBeUndefined();
    expect(env.detach).toHaveBeenCalledTimes(1);
  });

  it('surfaces ALREADY_ATTACHED when a foreign debugger holds the tab', async () => {
    env.attach.mockImplementationOnce((_d: any, _v: string, cb: () => void) => {
      env.runtime.lastError = { message: 'Another debugger is already attached to the tab with id: 1' };
      cb();
      env.runtime.lastError = undefined;
    });
    await expect(registry.acquire(1)).rejects.toThrow(/ALREADY_ATTACHED/);
    expect(registry.isAttached(1)).toBe(false);
  });

  it('forceDetach clears state under lock; the next acquire re-attaches cleanly', async () => {
    const stale = await registry.acquire(1);

    await registry.forceDetach(1);
    expect(env.detach).toHaveBeenCalledTimes(1);
    expect(registry.isAttached(1)).toBe(false);

    // A handle from the force-detached session no-ops on release.
    await expect(stale.release()).resolves.toBeUndefined();

    await registry.acquire(1);
    expect(env.attach).toHaveBeenCalledTimes(2);
    expect(registry.isAttached(1)).toBe(true);
  });

  it('notifies onDetach subscribers and reconciles on external detach', async () => {
    const h = await registry.acquire(1);
    const onDetach = vi.fn();
    h.onDetach(onDetach);

    // Simulate chrome firing onDetach for this tab.
    for (const l of env.detachListeners) l({ tabId: 1 }, 'target_closed');
    await new Promise((r) => setTimeout(r, 0)); // let the locked reconcile settle

    expect(onDetach).toHaveBeenCalledWith('target_closed');
    expect(registry.isAttached(1)).toBe(false);
  });

  it('installs exactly one chrome.debugger.onDetach listener', () => {
    expect(env.detachListeners.length).toBe(1);
  });

  it('does not time out a command that resolves promptly', async () => {
    const h = await registry.acquire(1);
    const res = await h.sendCommand('Runtime.evaluate', { expression: '1' });
    expect(res).toEqual({});
    expect(env.detach).not.toHaveBeenCalled();
    expect(registry.isAttached(1)).toBe(true);
  });

  it('times out a wedged command, force-detaches, and re-attaches on next acquire', async () => {
    vi.useFakeTimers();
    try {
      const h = await registry.acquire(1);
      // Make the next command hang: never invoke the chrome callback.
      env.sendCommand.mockImplementationOnce(() => {});

      const pending = h.sendCommand('Page.navigate', { url: 'x' }, { timeoutMs: 1000 });
      const rejects = expect(pending).rejects.toThrow(/CDP_COMMAND_TIMEOUT/);
      await vi.advanceTimersByTimeAsync(1000);
      await rejects;

      // Force-detached the wedged tab.
      expect(env.detach).toHaveBeenCalledTimes(1);
      expect(registry.isAttached(1)).toBe(false);

      // Next acquire re-attaches cleanly.
      await registry.acquire(1);
      expect(env.attach).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale handle release after force-detach does not detach the re-acquired session', async () => {
    const staleHandle = await registry.acquire(1); // session A
    await registry.forceDetach(1); // A torn down (detach #1)
    const fresh = await registry.acquire(1); // session B (attach #2), refs=1
    expect(env.attach).toHaveBeenCalledTimes(2);

    // Releasing the stale handle from session A must NOT decrement/detach B.
    await staleHandle.release();
    expect(env.detach).toHaveBeenCalledTimes(1); // only A's force-detach
    expect(registry.isAttached(1)).toBe(true); // B is still live

    await fresh.release();
    expect(env.detach).toHaveBeenCalledTimes(2); // now B detaches at refcount 0
  });
});
