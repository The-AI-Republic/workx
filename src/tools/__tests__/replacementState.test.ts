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
});
