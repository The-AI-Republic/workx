import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChromeManagedConfigSource } from '../ChromeManagedConfigSource';

const realChrome = (globalThis as any).chrome;

afterEach(() => {
  (globalThis as any).chrome = realChrome;
});

describe('ChromeManagedConfigSource', () => {
  it('builds a policy from chrome.storage.managed', async () => {
    (globalThis as any).chrome = {
      storage: {
        managed: {
          get: async (_keys: string[]) => ({
            values: { 'agent.approval.mode': 'yolo' },
            lockedKeys: ['agent.approval.mode'],
          }),
        },
      },
    };
    const p = await new ChromeManagedConfigSource().load();
    expect(p).toEqual({
      values: { 'agent.approval.mode': 'yolo' },
      lockedKeys: ['agent.approval.mode'],
      origin: 'chrome-managed',
    });
  });

  it('parses JSON-string values (the managed-schema wire format)', async () => {
    (globalThis as any).chrome = {
      storage: {
        managed: {
          get: async (_keys: string[]) => ({
            values: '{"agent.approval.mode": "strict", "tools.web_search": false}',
            lockedKeys: ['agent.approval.mode'],
          }),
        },
      },
    };
    const p = await new ChromeManagedConfigSource().load();
    expect(p).toEqual({
      values: { 'agent.approval.mode': 'strict', 'tools.web_search': false },
      lockedKeys: ['agent.approval.mode'],
      origin: 'chrome-managed',
    });
  });

  it('ignores malformed JSON-string values but keeps lockedKeys', async () => {
    (globalThis as any).chrome = {
      storage: {
        managed: {
          get: async () => ({ values: '{not json', lockedKeys: ['agent.approval.mode'] }),
        },
      },
    };
    const p = await new ChromeManagedConfigSource().load();
    expect(p).toEqual({ values: {}, lockedKeys: ['agent.approval.mode'], origin: 'chrome-managed' });
  });

  it('fails open when managed storage is unavailable', async () => {
    (globalThis as any).chrome = { storage: {} };
    expect(await new ChromeManagedConfigSource().load()).toBeNull();
  });

  it('returns null for an empty managed policy', async () => {
    (globalThis as any).chrome = {
      storage: { managed: { get: async () => ({}) } },
    };
    expect(await new ChromeManagedConfigSource().load()).toBeNull();
  });

  it('subscribe fires only for the managed area', () => {
    let handler: ((c: unknown, area: string) => void) | undefined;
    (globalThis as any).chrome = {
      storage: {
        onChanged: {
          addListener: (cb: (c: unknown, a: string) => void) => {
            handler = cb;
          },
          removeListener: vi.fn(),
        },
      },
    };
    const onChange = vi.fn();
    const unsub = new ChromeManagedConfigSource().subscribe(onChange);
    handler?.({}, 'local');
    expect(onChange).not.toHaveBeenCalled();
    handler?.({}, 'managed');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(() => unsub()).not.toThrow();
  });
});
