import { describe, it, expect } from 'vitest';
import { processUserInput } from '../processUserInput';
import type { FunnelContext, InputOrigin } from '../types';
import type { InputItem } from '../../protocol/types';

/** Minimal FunnelContext — Phase 1 only consults `origin`. */
function ctx(origin: InputOrigin): FunnelContext {
  return {
    sessionId: 's1',
    origin,
    // platform is unused by Phase 1 stages; cast keeps the test focused.
    platform: {} as FunnelContext['platform'],
  };
}

const text = (t: string): InputItem => ({ type: 'text', text: t });

describe('processUserInput — Phase 1', () => {
  it('passes plain local text through unchanged (never rewrites the prompt)', async () => {
    const items = [text('hello world')];
    const r = await processUserInput(items, ctx({ channel: 'local' }));
    expect(r.shouldQuery).toBe(true);
    expect(r.items).toEqual(items);
    expect((r.items[0] as { text: string }).text).toBe('hello world');
  });

  it('does NOT gate slash input from a local origin', async () => {
    const r = await processUserInput(
      [text('/settings')],
      ctx({ channel: 'local' }),
    );
    expect(r.shouldQuery).toBe(true);
    expect(r.resultText).toBeUndefined();
  });

  it('blocks an unsafe-known command from a connector', async () => {
    const r = await processUserInput(
      [text('/settings')],
      ctx({ channel: 'connector', channelType: 'telegram' }),
    );
    expect(r.shouldQuery).toBe(false);
    expect(r.resultText).toContain('/settings');
    expect(r.systemNote).toContain('telegram');
  });

  it('blocks /config from a remote relay (no leak to the model)', async () => {
    const r = await processUserInput(
      [text('/config set token x')],
      ctx({ channel: 'remote', channelType: 'websocket' }),
    );
    expect(r.shouldQuery).toBe(false);
    expect(r.resultText).toContain('/config');
  });

  it('lets a safe command (/help) through from a connector', async () => {
    const r = await processUserInput(
      [text('/help')],
      ctx({ channel: 'connector', channelType: 'telegram' }),
    );
    expect(r.shouldQuery).toBe(true);
  });

  it('treats an unknown slash from a connector as a plain prompt', async () => {
    const r = await processUserInput(
      [text('/wat is this')],
      ctx({ channel: 'connector', channelType: 'telegram' }),
    );
    expect(r.shouldQuery).toBe(true);
    expect(r.items).toHaveLength(1);
  });

  it('blocks an unsafe-known command from a scheduled job', async () => {
    const r = await processUserInput(
      [text('/login')],
      ctx({ channel: 'scheduler' }),
    );
    expect(r.shouldQuery).toBe(false);
  });

  it('picks the last text item as the prompt and preserves the rest', async () => {
    const items: InputItem[] = [
      { type: 'context', path: '/tmp/a' },
      text('/settings'),
    ];
    const r = await processUserInput(
      items,
      ctx({ channel: 'connector', channelType: 'slack' }),
    );
    // Prompt detected as the trailing text item → gated.
    expect(r.shouldQuery).toBe(false);
  });
});
