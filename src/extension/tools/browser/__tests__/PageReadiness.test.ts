import { describe, it, expect, vi } from 'vitest';
import { PageReadiness } from '../PageReadiness';

function fakeHandle() {
  let listener: ((m: string, p: unknown) => void) | null = null;
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.navigate') return { frameId: 'F1', loaderId: 'L1' };
    return {};
  });
  const handle = {
    tabId: 1,
    sendCommand,
    enableDomain: vi.fn().mockResolvedValue(undefined),
    onEvent: (cb: (m: string, p: unknown) => void) => {
      listener = cb;
    },
    offEvent: () => {
      listener = null;
    },
  } as any;
  const fire = (method: string, params: any) => listener?.(method, params);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { handle, fire, sendCommand, tick };
}

describe('PageReadiness', () => {
  it('enables Page domain and lifecycle events on construction', async () => {
    const { handle, sendCommand, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await pr.waitFor('load', { timeoutMs: 10 }); // also forces `ready` to settle
    expect(handle.enableDomain).toHaveBeenCalledWith('Page');
    expect(sendCommand).toHaveBeenCalledWith('Page.setLifecycleEventsEnabled', { enabled: true });
    pr.dispose();
    await tick();
  });

  it('resolves waitFor when the named lifecycle event fires for the loader', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    const p = pr.waitFor('load', { loaderId: 'L1' });
    await tick();
    fire('Page.lifecycleEvent', { loaderId: 'L1', name: 'load' });
    await expect(p).resolves.toBeUndefined();
    pr.dispose();
  });

  it('does not resolve on a load for a different loaderId (correlation)', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    const p = pr.waitFor('load', { loaderId: 'L1', timeoutMs: 50, failOpen: false });
    await tick();
    fire('Page.lifecycleEvent', { loaderId: 'L2', name: 'load' }); // wrong document
    await expect(p).rejects.toThrow('PAGE_READINESS_TIMEOUT');
    pr.dispose();
  });

  it('resolves immediately if the state was already seen', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    fire('Page.lifecycleEvent', { loaderId: 'L1', name: 'networkAlmostIdle' });
    await expect(pr.waitFor('networkAlmostIdle', { loaderId: 'L1' })).resolves.toBeUndefined();
    pr.dispose();
  });

  it('fails open on timeout by default', async () => {
    const { handle, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    await expect(pr.waitFor('load', { loaderId: 'never', timeoutMs: 10 })).resolves.toBeUndefined();
    pr.dispose();
  });

  it('forwards javascript dialogs', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    const onDialog = vi.fn();
    pr.onDialog(onDialog);
    fire('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
    expect(onDialog).toHaveBeenCalledWith({ type: 'confirm', message: 'Sure?' });
    pr.dispose();
  });

  it('navigate returns correlation ids and waits on the new loader', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    const navPromise = pr.navigate('https://example.com', 'load');
    await tick();
    fire('Page.lifecycleEvent', { loaderId: 'L1', name: 'load' });
    const result = await navPromise;
    expect(result).toEqual({ frameId: 'F1', loaderId: 'L1' });
  });

  it('caps the seen loaderId map across many navigations', async () => {
    const { handle, fire, tick } = fakeHandle();
    const pr = new PageReadiness(handle);
    await tick();
    for (let i = 0; i < 20; i++) {
      fire('Page.lifecycleEvent', { loaderId: `L${i}`, name: 'load' });
    }
    expect((pr as any).seen.size).toBeLessThanOrEqual(8);
    pr.dispose();
  });
});
