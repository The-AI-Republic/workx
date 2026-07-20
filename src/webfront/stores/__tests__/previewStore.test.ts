import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@/core/protocol/types';
import { LOCAL_FILE_SOURCE_MAX_BYTES } from '@/tools/runtimeMetadata';
import {
  MAX_PREVIEW_ITEMS,
  previewStore,
  type PreviewProjectionContext,
} from '../previewStore';

const liveWide: PreviewProjectionContext = {
  isActive: true,
  isWide: true,
  isReplay: false,
};

function changeEvent(
  id: string,
  overrides: Record<string, unknown> = {},
): Event {
  return {
    id,
    msg: {
      type: 'ToolExecutionProgress',
      data: {
        tool_name: 'edit_file',
        call_id: `call-${id}`,
        turn_id: 'turn-1',
        timestamp: Number(id.replace(/\D/g, '')) || 1,
        progress_data: {
          type: 'local_file_change',
          status: 'completed',
          operation: 'modified',
          path: `src/${id}.ts`,
          size: 20,
          mtimeMs: 10,
          unifiedDiff: `--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
          message: `Modified src/${id}.ts`,
          ...overrides,
        },
      },
    },
  };
}

function taskStarted(id = 'task'): Event {
  return {
    id,
    msg: {
      type: 'TaskStarted',
      data: { model: 'test', tabId: -1 },
    },
  };
}

describe('previewStore', () => {
  beforeEach(() => previewStore.reset());

  it('projects an eligible local change, selects Diff, and auto-opens active wide live work', () => {
    const id = previewStore.projectEvent('s1', changeEvent('e1'), liveWide);
    const state = previewStore.getSession('s1');

    expect(id).toBe('e1');
    expect(state).toMatchObject({
      selectedItemId: 'e1',
      selectedView: 'diff',
      open: true,
      unread: false,
    });
    expect(state.items[0]).toMatchObject({
      id: 'e1',
      sessionId: 's1',
      sourceCallId: 'call-e1',
      turnId: 'turn-1',
      resource: { type: 'local-text-file', path: 'src/e1.ts' },
      availableViews: ['diff', 'source'],
    });
  });

  it('offers sanitized-rendering eligibility only for Markdown and never defaults to it', () => {
    previewStore.projectEvent('s1', changeEvent('doc1', {
      path: 'README.md',
      unifiedDiff: undefined,
      diffOmittedReason: 'input_too_large',
    }), liveWide);

    expect(previewStore.getSession('s1')).toMatchObject({
      selectedView: 'source',
      items: [{ availableViews: ['rendered', 'source'] }],
    });
  });

  it.each([
    ['narrow', { isActive: true, isWide: false, isReplay: false }],
    ['background', { isActive: false, isWide: true, isReplay: false }],
    ['replay', { isActive: true, isWide: true, isReplay: true }],
  ] as const)('keeps %s changes closed and unread', (_label, context) => {
    previewStore.projectEvent('s1', changeEvent('e1'), context);
    expect(previewStore.getSession('s1')).toMatchObject({ open: false, unread: true });
  });

  it('suppresses later auto-open after close until the next task starts', () => {
    previewStore.projectEvent('s1', changeEvent('e1'), liveWide);
    previewStore.closeSession('s1');
    previewStore.projectEvent('s1', changeEvent('e2'), liveWide);
    expect(previewStore.getSession('s1')).toMatchObject({
      open: false,
      unread: true,
      autoOpenSuppressed: true,
    });

    previewStore.projectEvent('s1', taskStarted(), liveWide);
    expect(previewStore.getSession('s1').autoOpenSuppressed).toBe(false);
    previewStore.projectEvent('s1', changeEvent('e3'), liveWide);
    expect(previewStore.getSession('s1')).toMatchObject({ open: true, unread: false });
  });

  it('replaces duplicate event ids without appending or reopening', () => {
    previewStore.projectEvent('s1', changeEvent('e1'), liveWide);
    previewStore.closeSession('s1');
    previewStore.projectEvent('s1', changeEvent('e1', { mtimeMs: 99 }), liveWide);

    const state = previewStore.getSession('s1');
    expect(state.items).toHaveLength(1);
    expect(state.items[0].mtimeMs).toBe(99);
    expect(state.open).toBe(false);
    expect(state.unread).toBe(false);
  });

  it('rejects unrelated, malformed, absolute, and oversized progress payloads', () => {
    expect(previewStore.projectEvent('s1', taskStarted(), liveWide)).toBeNull();
    expect(previewStore.projectEvent('s1', changeEvent('bad1', { status: 'started' }), liveWide)).toBeNull();
    expect(previewStore.projectEvent('s1', changeEvent('bad2', { path: '/tmp/a.ts' }), liveWide)).toBeNull();
    expect(previewStore.projectEvent('s1', changeEvent('bad3', {
      size: LOCAL_FILE_SOURCE_MAX_BYTES + 1,
    }), liveWide)).toBeNull();
    expect(previewStore.getSession('s1').items).toEqual([]);
  });

  it('retains only the newest 20 items', () => {
    for (let index = 0; index < MAX_PREVIEW_ITEMS + 5; index++) {
      previewStore.projectEvent('s1', changeEvent(`e${index}`), {
        isActive: false,
        isWide: true,
        isReplay: false,
      });
    }
    const ids = previewStore.getSession('s1').items.map((item) => item.id);
    expect(ids).toHaveLength(MAX_PREVIEW_ITEMS);
    expect(ids[0]).toBe('e24');
    expect(ids).not.toContain('e0');
  });

  it('enforces the per-thread retained-diff byte budget by evicting older items', () => {
    const largeDiff = 'x'.repeat(600 * 1024);
    previewStore.projectEvent('s1', changeEvent('e1', { unifiedDiff: largeDiff }), liveWide);
    previewStore.projectEvent('s1', changeEvent('e2', { unifiedDiff: largeDiff }), liveWide);

    const state = previewStore.getSession('s1');
    expect(state.items.map((item) => item.id)).toEqual(['e2']);
  });

  it('keeps a newest source item but drops a single impossible over-budget diff', () => {
    previewStore.projectEvent('s1', changeEvent('e1', {
      unifiedDiff: 'x'.repeat(1024 * 1024 + 1),
    }), liveWide);
    const state = previewStore.getSession('s1');
    expect(state.items[0]).toMatchObject({ id: 'e1', availableViews: ['source'] });
    expect(state.items[0].unifiedDiff).toBeUndefined();
    expect(state.selectedView).toBe('source');
  });

  it('reveals exact items and validates view selection', () => {
    previewStore.projectEvent('s1', changeEvent('e1', { path: 'README.md' }), {
      isActive: false,
      isWide: false,
      isReplay: false,
    });
    previewStore.selectView('s1', 'rendered');
    expect(previewStore.getSession('s1').selectedView).toBe('rendered');
    previewStore.selectView('s1', 'source');
    previewStore.revealItem('s1', 'e1');
    expect(previewStore.getSession('s1')).toMatchObject({
      selectedItemId: 'e1',
      selectedView: 'diff',
      open: true,
      unread: false,
    });
  });

  it('clears a workspace and removes a deleted thread independently', () => {
    previewStore.projectEvent('s1', changeEvent('e1'), liveWide);
    previewStore.projectEvent('s2', changeEvent('e2'), liveWide);
    previewStore.clearSession('s1');
    expect(previewStore.getSession('s1').items).toEqual([]);
    expect(previewStore.getSession('s2').items).toHaveLength(1);

    previewStore.removeSession('s2');
    expect(previewStore.getSession('s2')).toMatchObject({ items: [], open: false });
  });
});
