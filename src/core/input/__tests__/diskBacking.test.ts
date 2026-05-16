import { describe, it, expect, vi } from 'vitest';
import { processUserInput } from '../processUserInput';
import type { FunnelContext } from '../types';
import type { InputItem } from '../../protocol/types';
import type { ToolResultStore, PersistedResult } from '../../../tools/resultStore';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../../tools/toolLimits';

function fakeStore(): ToolResultStore & { calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    async persist(sessionId, toolUseId, content): Promise<PersistedResult> {
      calls.push([sessionId, toolUseId, content]);
      return {
        reference: `/data/${sessionId}/${toolUseId}.txt`,
        kind: 'file',
        originalSize: content.length,
        preview: content.slice(0, 50),
        hasMore: content.length > 50,
      };
    },
    async retrieve() {
      return null;
    },
    async cleanup() {},
  };
}

function ctx(store?: ToolResultStore): FunnelContext {
  return {
    sessionId: 'sess1',
    origin: { channel: 'local' },
    platform: {} as FunnelContext['platform'],
    resultStore: store,
  };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('processUserInput — Phase 2 disk-backing', () => {
  it('keeps the inline image AND appends an [Image source] breadcrumb', async () => {
    const store = fakeStore();
    const items: InputItem[] = [
      { type: 'text', text: 'what is this?' },
      { type: 'image', image_url: PNG },
    ];
    const r = await processUserInput(items, ctx(store));
    expect(r.shouldQuery).toBe(true);
    // inline image preserved for vision
    expect(r.items.some((i) => i.type === 'image')).toBe(true);
    // breadcrumb appended
    const crumb = r.items.find(
      (i) => i.type === 'text' && i.text.startsWith('[Image source:'),
    );
    expect(crumb).toBeTruthy();
    // persisted with a content-addressed, idempotent id
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0][1]).toMatch(/^paste-[0-9a-f]{8}$/);
    expect(store.calls[0][2]).toContain('"mime":"image/png"');
  });

  it('is idempotent — same image yields the same toolUseId', async () => {
    const store = fakeStore();
    await processUserInput([{ type: 'image', image_url: PNG }], ctx(store));
    await processUserInput([{ type: 'image', image_url: PNG }], ctx(store));
    expect(store.calls[0][1]).toBe(store.calls[1][1]);
  });

  it('leaves the image inline (no breadcrumb) when no store is available', async () => {
    const r = await processUserInput(
      [{ type: 'image', image_url: PNG }],
      ctx(undefined),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].type).toBe('image');
  });

  it('does not throw or break the turn if persist fails', async () => {
    const store = fakeStore();
    store.persist = vi.fn().mockRejectedValue(new Error('disk full'));
    const r = await processUserInput(
      [{ type: 'image', image_url: PNG }],
      ctx(store),
    );
    expect(r.shouldQuery).toBe(true);
    expect(r.items[0].type).toBe('image'); // still attached
    expect(r.systemNote).toContain('Could not persist');
  });

  it('collapses an oversized clipboard paste to a <persisted-output> marker', async () => {
    const store = fakeStore();
    const big = 'x'.repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 10);
    const r = await processUserInput(
      [{ type: 'clipboard', content: big }],
      ctx(store),
    );
    expect(store.calls).toHaveLength(1);
    const marker = r.items.find(
      (i) => i.type === 'text' && i.text.includes('[Pasted text #1]'),
    );
    expect(marker).toBeTruthy();
    expect((marker as { text: string }).text).toContain('<persisted-output>');
  });

  it('leaves a small clipboard paste untouched', async () => {
    const store = fakeStore();
    const items: InputItem[] = [{ type: 'clipboard', content: 'short' }];
    const r = await processUserInput(items, ctx(store));
    expect(store.calls).toHaveLength(0);
    expect(r.items).toEqual(items);
  });
});
