import { describe, it, expect } from 'vitest';
import {
  LOCAL_BROWSER_ACTIONS,
  LOCAL_BROWSER_TOOL,
  localBrowserToolDescriptor,
  mapLocalBrowserAction,
} from '../localBrowserTool';

describe('localBrowserToolDescriptor', () => {
  it('advertises one tool whose action enum matches the mapping', () => {
    const desc = localBrowserToolDescriptor();
    expect(desc.name).toBe(LOCAL_BROWSER_TOOL);
    const actionSchema = (desc.parameters as any).properties.action;
    expect(actionSchema.enum).toEqual([...LOCAL_BROWSER_ACTIONS]);
    expect((desc.parameters as any).required).toEqual(['action']);
  });
});

describe('mapLocalBrowserAction', () => {
  it('maps tab actions to the executor tabs handler', () => {
    expect(mapLocalBrowserAction({ action: 'list_tabs' })).toEqual({
      target: 'tabs',
      params: { action: 'list' },
    });
    expect(mapLocalBrowserAction({ action: 'select_tab', tab_id: 7 })).toEqual({
      target: 'tabs',
      params: { action: 'select', tab_id: 7 },
    });
    expect(mapLocalBrowserAction({ action: 'open_tab', url: 'https://x.test' })).toEqual({
      target: 'tabs',
      params: { action: 'open', url: 'https://x.test' },
    });
    expect(mapLocalBrowserAction({ action: 'close_tab' })).toEqual({
      target: 'tabs',
      params: { action: 'close' },
    });
  });

  it('maps navigation actions onto browser_navigation', () => {
    const nav = mapLocalBrowserAction({ action: 'navigate', url: 'https://x.test' });
    expect(nav).toMatchObject({
      target: 'registry',
      toolName: 'browser_navigation',
      params: { action: 'navigate', url: 'https://x.test' },
      autoOpenTab: true,
    });
    expect(mapLocalBrowserAction({ action: 'back' })).toMatchObject({
      toolName: 'browser_navigation',
      params: { action: 'goBack' },
    });
    expect(mapLocalBrowserAction({ action: 'reload' })).toMatchObject({
      toolName: 'browser_navigation',
      params: { action: 'reload' },
    });
  });

  it('maps DOM actions onto browser_dom (press_key -> keypress)', () => {
    expect(mapLocalBrowserAction({ action: 'snapshot' })).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'snapshot' },
    });
    expect(mapLocalBrowserAction({ action: 'click', node_id: '0:12' })).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'click', node_id: '0:12' },
    });
    expect(
      mapLocalBrowserAction({ action: 'type', node_id: '0:12', text: 'hi', options: { commit: 'enter' } }),
    ).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'type', node_id: '0:12', text: 'hi', options: { commit: 'enter' } },
    });
    expect(mapLocalBrowserAction({ action: 'press_key', key: 'Enter' })).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'keypress', key: 'Enter' },
    });
    expect(mapLocalBrowserAction({ action: 'scroll', node_id: '0:1' })).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'scroll', node_id: '0:1' },
    });
  });

  it('maps extract onto data_extraction with mode defaulting to auto', () => {
    expect(mapLocalBrowserAction({ action: 'extract', context: 'prices' })).toMatchObject({
      toolName: 'data_extraction',
      params: { mode: 'auto', context: 'prices' },
    });
    expect(
      mapLocalBrowserAction({ action: 'extract', mode: 'table', options: { tableSelector: '#t' } }),
    ).toMatchObject({
      toolName: 'data_extraction',
      params: { mode: 'table', tableSelector: '#t' },
    });
  });

  it('returns teaching errors for missing per-action params', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'select_tab' }, 'list_tabs'],
      [{ action: 'navigate' }, 'url'],
      [{ action: 'click' }, 'snapshot'],
      [{ action: 'type', node_id: '0:1' }, 'text'],
      [{ action: 'press_key' }, 'key'],
      [{ action: 'scroll' }, 'snapshot'],
    ];
    for (const [params, hint] of cases) {
      const res = mapLocalBrowserAction(params);
      expect(res.target).toBe('error');
      expect((res as { message: string }).message).toContain(hint);
    }
  });

  it('rejects unknown/missing actions with the valid-action list', () => {
    const missing = mapLocalBrowserAction({});
    expect(missing.target).toBe('error');
    expect((missing as { message: string }).message).toContain('list_tabs');

    const unknown = mapLocalBrowserAction({ action: 'teleport' });
    expect(unknown).toMatchObject({ target: 'error', code: 'UNKNOWN_ACTION' });
    expect((unknown as { message: string }).message).toContain('teleport');
  });

  it('type accepts empty text (clear-field case)', () => {
    expect(mapLocalBrowserAction({ action: 'type', node_id: '0:1', text: '' })).toMatchObject({
      toolName: 'browser_dom',
      params: { action: 'type', text: '' },
    });
  });
});
