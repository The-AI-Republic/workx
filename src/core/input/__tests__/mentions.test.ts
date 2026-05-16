import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseMentions, resolveMentions, blockedUrlReason } from '../mentions';
import { processUserInput } from '../processUserInput';
import type { FunnelContext } from '../types';
import type { IPlatformAdapter, IBrowserController } from '../../platform/IPlatformAdapter';
import type { ToolResultStore, PersistedResult } from '../../../tools/resultStore';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../../tools/toolLimits';

describe('parseMentions', () => {
  it('parses every mention form without rewriting the prompt', () => {
    const text =
      'look at @page and @tab and @tab:42 plus @selection then @url https://x.com/a done';
    const m = parseMentions(text);
    expect(m).toEqual([
      { kind: 'page' },
      { kind: 'tab' },
      { kind: 'tab', tabId: 42 },
      { kind: 'selection' },
      { kind: 'url', addr: 'https://x.com/a' },
    ]);
  });

  it('ignores non-mentions and bare @ words', () => {
    expect(parseMentions('email me @someone about @tabby')).toEqual([]);
  });

  it('de-duplicates repeated mentions', () => {
    expect(parseMentions('@page @page @tab @tab')).toEqual([
      { kind: 'page' },
      { kind: 'tab' },
    ]);
  });

  it('only accepts http(s) addresses for @url', () => {
    expect(parseMentions('@url ftp://nope')).toEqual([]);
    expect(parseMentions('@url not-a-url')).toEqual([]);
  });

  it('tolerates punctuation around mentions', () => {
    expect(parseMentions('see (@tab) and @page. then @selection!')).toEqual([
      { kind: 'tab' },
      { kind: 'page' },
      { kind: 'selection' },
    ]);
    expect(parseMentions('fetch @url https://x.com/a, please')).toEqual([
      { kind: 'url', addr: 'https://x.com/a' },
    ]);
  });
});

describe('blockedUrlReason (SSRF guard)', () => {
  it('blocks loopback / private / link-local / metadata targets', () => {
    for (const u of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://127.5.5.5/x',
      'http://0.0.0.0/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'ftp://example.com/',
    ]) {
      expect(blockedUrlReason(u)).not.toBeNull();
    }
  });

  it('allows public addresses', () => {
    expect(blockedUrlReason('https://example.com/a')).toBeNull();
    expect(blockedUrlReason('http://8.8.8.8/')).toBeNull();
    expect(blockedUrlReason('http://172.32.0.1/')).toBeNull(); // just outside private
  });
});

function controller(over: Partial<IBrowserController> = {}): IBrowserController {
  return {
    async navigate() {},
    async getPageContent() {
      return '<html>page body</html>';
    },
    async screenshot() {
      return '';
    },
    ...over,
  };
}

function platform(
  flags: { hasBrowserTools: boolean; hasRealTabs: boolean },
  ctrl: IBrowserController | null,
): IPlatformAdapter {
  return {
    platformId: 'extension',
    hasBrowserTools: flags.hasBrowserTools,
    hasRealTabs: flags.hasRealTabs,
    async getBrowserController() {
      return ctrl;
    },
  } as unknown as IPlatformAdapter;
}

function ctx(p: IPlatformAdapter): FunnelContext {
  return { sessionId: 's', origin: { channel: 'local' }, platform: p, tabId: 7 };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveMentions — capability gating', () => {
  it('resolves @page into an appended <page> item, prompt untouched', async () => {
    const items = [{ type: 'text' as const, text: 'summarize @page please' }];
    const r = await processUserInput(
      items,
      ctx(platform({ hasBrowserTools: true, hasRealTabs: true }, controller())),
    );
    expect((r.items[0] as { text: string }).text).toBe('summarize @page please');
    const pageItem = r.items.find(
      (i) => i.type === 'text' && i.text.startsWith('<page'),
    );
    expect(pageItem).toBeTruthy();
    expect((pageItem as { text: string }).text).toContain('page body');
  });

  it('degrades @page to a systemNote when no browser is attached', async () => {
    const r = await processUserInput(
      [{ type: 'text', text: 'check @page' }],
      ctx(platform({ hasBrowserTools: false, hasRealTabs: false }, null)),
    );
    expect(r.shouldQuery).toBe(true); // turn proceeds
    expect(r.items).toHaveLength(1); // nothing appended
    expect(r.systemNote).toContain('@page unavailable');
  });

  it('degrades @tab when the platform has no real tabs', async () => {
    const r = await processUserInput(
      [{ type: 'text', text: '@tab' }],
      ctx(platform({ hasBrowserTools: true, hasRealTabs: false }, controller())),
    );
    expect(r.systemNote).toContain('@tab unavailable');
  });

  it('resolves @selection and degrades on empty selection', async () => {
    const ok = await processUserInput(
      [{ type: 'text', text: 'explain @selection' }],
      ctx(
        platform(
          { hasBrowserTools: true, hasRealTabs: true },
          controller({ getSelectionText: async () => '  the selected text  ' }),
        ),
      ),
    );
    expect(
      ok.items.find((i) => i.type === 'text' && i.text.includes('selected text')),
    ).toBeTruthy();

    const empty = await processUserInput(
      [{ type: 'text', text: 'explain @selection' }],
      ctx(
        platform(
          { hasBrowserTools: true, hasRealTabs: true },
          controller({ getSelectionText: async () => '   ' }),
        ),
      ),
    );
    expect(empty.systemNote).toContain('nothing is selected');
  });

  it('degrades @selection when the controller lacks the capability', async () => {
    const r = await processUserInput(
      [{ type: 'text', text: '@selection' }],
      ctx(
        platform({ hasBrowserTools: true, hasRealTabs: true }, controller()),
      ),
    );
    expect(r.systemNote).toContain('@selection unavailable');
  });

  it('@url works capability-independently and reports fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'remote body',
      }),
    );
    const r = await processUserInput(
      [{ type: 'text', text: 'read @url https://example.com/x' }],
      ctx(platform({ hasBrowserTools: false, hasRealTabs: false }, null)),
    );
    expect(
      r.items.find((i) => i.type === 'text' && i.text.includes('remote body')),
    ).toBeTruthy();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }),
    );
    const fail = await processUserInput(
      [{ type: 'text', text: '@url https://example.com/down' }],
      ctx(platform({ hasBrowserTools: false, hasRealTabs: false }, null)),
    );
    expect(fail.systemNote).toContain('HTTP 503');
  });

  it('refuses an SSRF @url target without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await processUserInput(
      [{ type: 'text', text: 'read @url http://169.254.169.254/latest/meta-data/' }],
      ctx(platform({ hasBrowserTools: false, hasRealTabs: false }, null)),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.systemNote).toContain('refused');
    expect(r.items).toHaveLength(1); // nothing appended
  });

  it('times out a hung page resolution instead of stalling', async () => {
    vi.useFakeTimers();
    const r = processUserInput(
      [{ type: 'text', text: 'read @page' }],
      ctx(
        platform(
          { hasBrowserTools: true, hasRealTabs: true },
          controller({ getPageContent: () => new Promise<string>(() => {}) }),
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(9000);
    const res = await r;
    vi.useRealTimers();
    expect(res.shouldQuery).toBe(true);
    expect(res.systemNote).toContain('timed out');
  });

  it('persists oversized mention content under a content-addressed idempotent id', async () => {
    const calls: string[] = [];
    const store: ToolResultStore = {
      async persist(_s, toolUseId, content): Promise<PersistedResult> {
        calls.push(toolUseId);
        return {
          reference: `/d/${toolUseId}`,
          kind: 'file',
          originalSize: content.length,
          preview: content.slice(0, 20),
          hasMore: true,
        };
      },
      async retrieve() {
        return null;
      },
      async cleanup() {},
    };
    const big = 'p'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 100);
    const p = platform(
      { hasBrowserTools: true, hasRealTabs: true },
      controller({ getPageContent: async () => big }),
    );
    const c = { ...ctx(p), resultStore: store };
    await processUserInput([{ type: 'text', text: '@page' }], c);
    await processUserInput([{ type: 'text', text: '@page' }], c);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^mention-page-[0-9a-f]{8}$/);
    expect(calls[0]).toBe(calls[1]); // idempotent across resubmission
  });

  it('never aborts a scheduled job when a mention throws', async () => {
    const r = await processUserInput(
      [{ type: 'text', text: 'do @page now' }],
      {
        sessionId: 's',
        origin: { channel: 'scheduler' },
        platform: platform(
          { hasBrowserTools: true, hasRealTabs: true },
          controller({
            getPageContent: async () => {
              throw new Error('tab crashed');
            },
          }),
        ),
        tabId: 1,
      },
    );
    expect(r.shouldQuery).toBe(true);
    expect(r.systemNote).toContain('could not be resolved');
  });
});
