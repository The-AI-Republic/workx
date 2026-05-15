import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseMentions, resolveMentions } from '../mentions';
import { processUserInput } from '../processUserInput';
import type { FunnelContext } from '../types';
import type { IPlatformAdapter, IBrowserController } from '../../platform/IPlatformAdapter';

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
