import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChromeDebuggerClient } from '../ChromeDebuggerClient';

/** OOPIF prerequisite (design §3.7): target-addressed commands + enumeration. */
describe('ChromeDebuggerClient OOPIF support', () => {
  let sendCommand: ReturnType<typeof vi.fn>;
  let getTargets: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendCommand = vi.fn((_debuggee: any, _method: string, _params: any, cb: (r: unknown) => void) => cb({ ok: true }));
    getTargets = vi.fn((cb: (t: unknown[]) => void) => cb([{ id: 'T1', type: 'iframe', tabId: 5 }]));
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      runtime: { lastError: undefined },
      debugger: {
        attach: vi.fn((_d: any, _v: string, cb: () => void) => cb()),
        detach: vi.fn((_d: any, cb: () => void) => cb()),
        sendCommand,
        getTargets,
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  it('addresses sendCommandToTarget at {targetId}', async () => {
    const client = new ChromeDebuggerClient();
    await client.attach({ tabId: 5 });

    const result = await client.sendCommandToTarget('TARGET-1', 'DOM.getDocument', { depth: -1 });

    expect(result).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledWith(
      { targetId: 'TARGET-1' },
      'DOM.getDocument',
      { depth: -1 },
      expect.any(Function)
    );
  });

  it('rejects target commands when not attached', async () => {
    const client = new ChromeDebuggerClient();
    await expect(client.sendCommandToTarget('T1', 'DOM.getDocument')).rejects.toThrow('Debugger not attached');
  });

  it('enumerates debuggable targets', async () => {
    const client = new ChromeDebuggerClient();
    const targets = await client.getTargets();
    expect(targets).toEqual([{ id: 'T1', type: 'iframe', tabId: 5 }]);
  });
});
