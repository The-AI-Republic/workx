import { describe, it, expect, vi, beforeEach } from 'vitest';

const acquire = vi.fn();
vi.mock('@/extension/tools/browser/ChromeDebuggerSessionRegistry', () => ({
  getDebuggerSessionRegistry: () => ({ acquire }),
}));

import { ViewportTool, __resetViewportOverridesForTests } from '@/extension/tools/ViewportTool';

function fakeHandle() {
  let detachCb: (() => void) | null = null;
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Runtime.evaluate') return { result: { value: { width: 1000, height: 800 } } };
    return {};
  });
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    sendCommand,
    release,
    onDetach: (cb: () => void) => {
      detachCb = cb;
      return () => {
        detachCb = null;
      };
    },
    fireDetach: () => detachCb?.(),
  };
}

describe('ViewportTool override lifecycle', () => {
  beforeEach(() => {
    __resetViewportOverridesForTests();
    acquire.mockReset();
  });

  it('cleans up the held handle when the session detaches externally', async () => {
    const h1 = fakeHandle();
    acquire.mockResolvedValueOnce(h1 as any);
    const tool = new ViewportTool();

    await tool.execute({ action: 'set', width: 375, height: 667 }, { metadata: { tabId: 5 } });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(h1.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ deviceScaleFactor: 1 })
    );

    // External detach (tab closed / infobar) → entry cleaned up.
    h1.fireDetach();

    // A subsequent set must RE-ACQUIRE (entry removed), not reuse the dead handle.
    const h2 = fakeHandle();
    acquire.mockResolvedValueOnce(h2 as any);
    await tool.execute({ action: 'set', width: 400, height: 700 }, { metadata: { tabId: 5 } });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('reset clears the override and releases the handle', async () => {
    const h = fakeHandle();
    acquire.mockResolvedValueOnce(h as any);
    const tool = new ViewportTool();

    await tool.execute({ action: 'set' }, { metadata: { tabId: 9 } });
    await tool.execute({ action: 'reset' }, { metadata: { tabId: 9 } });

    expect(h.sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
    expect(h.release).toHaveBeenCalled();

    // After reset, set re-acquires.
    const h2 = fakeHandle();
    acquire.mockResolvedValueOnce(h2 as any);
    await tool.execute({ action: 'set' }, { metadata: { tabId: 9 } });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('reuses the held handle across repeated set calls (no double-acquire)', async () => {
    const h = fakeHandle();
    acquire.mockResolvedValueOnce(h as any);
    const tool = new ViewportTool();

    await tool.execute({ action: 'set', width: 375, height: 667 }, { metadata: { tabId: 7 } });
    await tool.execute({ action: 'set', width: 414, height: 896 }, { metadata: { tabId: 7 } });
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
