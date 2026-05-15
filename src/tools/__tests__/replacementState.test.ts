import { describe, it, expect, vi } from 'vitest';
import {
  ContentReplacementState,
  type ContentReplacementRecord,
} from '@/tools/replacementState';

describe('ContentReplacementState', () => {
  it('record() adds to seenIds + replacements AND fires onRecord', () => {
    const onRecord = vi.fn();
    const state = new ContentReplacementState({ onRecord });
    state.record('call_1', '<persisted-output>preview</persisted-output>');

    expect(state.seenIds.has('call_1')).toBe(true);
    expect(state.replacements.get('call_1')).toBe(
      '<persisted-output>preview</persisted-output>',
    );
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledWith({
      kind: 'tool-result',
      toolUseId: 'call_1',
      replacement: '<persisted-output>preview</persisted-output>',
    });
  });

  it('seedFromResume() populates state WITHOUT firing onRecord', () => {
    const onRecord = vi.fn();
    const state = new ContentReplacementState({ onRecord });
    const rec: ContentReplacementRecord = {
      kind: 'tool-result',
      toolUseId: 'call_2',
      replacement: 'X',
    };
    state.seedFromResume(rec);

    expect(state.seenIds.has('call_2')).toBe(true);
    expect(state.replacements.get('call_2')).toBe('X');
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('freezeUnreplaced() adds only to seenIds', () => {
    const state = new ContentReplacementState();
    state.freezeUnreplaced('call_3');
    expect(state.seenIds.has('call_3')).toBe(true);
    expect(state.replacements.has('call_3')).toBe(false);
  });

  it('reapply() returns the stored replacement string', () => {
    const state = new ContentReplacementState();
    state.record('call_4', 'replacement-string');
    expect(state.reapply('call_4')).toBe('replacement-string');
  });

  it('reapply() returns undefined for never-seen or seen-unreplaced ids', () => {
    const state = new ContentReplacementState();
    expect(state.reapply('unknown')).toBeUndefined();
    state.freezeUnreplaced('frozen-only');
    expect(state.reapply('frozen-only')).toBeUndefined();
  });

  it('record() with no onRecord option does not throw', () => {
    const state = new ContentReplacementState();
    expect(() => state.record('call_5', 'x')).not.toThrow();
  });

  it('evicts oldest entries FIFO once maxEntries is exceeded', () => {
    const state = new ContentReplacementState({ maxEntries: 3 });
    state.record('a', 'A');
    state.record('b', 'B');
    state.record('c', 'C');
    state.record('d', 'D'); // forces eviction of 'a'

    expect(state.seenIds.has('a')).toBe(false);
    expect(state.replacements.has('a')).toBe(false);
    expect(state.seenIds.has('d')).toBe(true);
    expect(state.replacements.get('d')).toBe('D');
    expect(state.seenIds.size).toBe(3);
    expect(state.replacements.size).toBe(3);
  });

  it('keeps seenIds and replacements in sync under eviction even for mixed insert paths', () => {
    const state = new ContentReplacementState({ maxEntries: 2 });
    state.freezeUnreplaced('frozen-1'); // seen, no replacement
    state.record('with-repl', 'r');     // seen + replacement
    state.record('another', 'r2');      // forces eviction of 'frozen-1'

    expect(state.seenIds.has('frozen-1')).toBe(false);
    expect(state.replacements.has('frozen-1')).toBe(false);
    expect(state.seenIds.has('with-repl')).toBe(true);
    expect(state.seenIds.has('another')).toBe(true);
  });

  it('seedFromResume() also evicts when the cap is exceeded', () => {
    const state = new ContentReplacementState({ maxEntries: 2 });
    state.seedFromResume({ kind: 'tool-result', toolUseId: 'a', replacement: 'A' });
    state.seedFromResume({ kind: 'tool-result', toolUseId: 'b', replacement: 'B' });
    state.seedFromResume({ kind: 'tool-result', toolUseId: 'c', replacement: 'C' });
    expect(state.seenIds.has('a')).toBe(false);
    expect(state.seenIds.size).toBe(2);
  });
});
