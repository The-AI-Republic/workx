import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureContentScript, __resetEnsureContentScriptForTests } from '../ensureContentScript';

describe('ensureContentScript', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetEnsureContentScriptForTests();
    sendMessage = vi.fn();
    executeScript = vi.fn().mockResolvedValue([{ result: true }]);
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      tabs: { sendMessage },
      scripting: { executeScript },
    };
  });

  it('returns true without injecting when the ping succeeds', async () => {
    sendMessage.mockResolvedValue({ pong: true });
    const ok = await ensureContentScript(1);
    expect(ok).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('injects then re-pings when the first ping fails', async () => {
    // First ping rejects (no listener); after inject, ping succeeds.
    sendMessage.mockRejectedValueOnce(new Error('no receiver')).mockResolvedValueOnce({ pong: true });
    const ok = await ensureContentScript(2);
    expect(ok).toBe(true);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 2 },
      files: ['content.js'],
      injectImmediately: true,
    });
  });

  it('dedupes concurrent injections for the same tab', async () => {
    sendMessage.mockRejectedValueOnce(new Error('no receiver')) // ping A
      .mockRejectedValueOnce(new Error('no receiver')) // ping B (both miss before inject)
      .mockResolvedValue({ pong: true }); // re-pings after inject
    const [a, b] = await Promise.all([ensureContentScript(3), ensureContentScript(3)]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // Only one injection despite two concurrent callers.
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('returns false when injection fails', async () => {
    sendMessage.mockRejectedValue(new Error('no receiver'));
    executeScript.mockRejectedValue(new Error('cannot access'));
    const ok = await ensureContentScript(4);
    expect(ok).toBe(false);
  });
});
