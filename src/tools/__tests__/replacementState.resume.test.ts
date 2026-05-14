/**
 * Verifies that ContentReplacementState survives a "save + reload" cycle:
 * - record() emits a ContentReplacementRecord via onRecord.
 * - seedFromResume() can rebuild byte-identical state without re-firing
 *   onRecord.
 *
 * This is the persistence-replay invariant that keeps prompt cache warm.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ContentReplacementState,
  type ContentReplacementRecord,
} from '@/tools/replacementState';

describe('ContentReplacementState resume cycle', () => {
  it('round-trips a recorded decision through onRecord → seedFromResume', () => {
    const captured: ContentReplacementRecord[] = [];
    const original = new ContentReplacementState({
      onRecord: (rec) => captured.push(rec),
    });
    original.record('call_a', '<persisted-output>A</persisted-output>');
    original.record('call_b', '<persisted-output>B</persisted-output>');
    original.freezeUnreplaced('call_c'); // pass-through, NOT captured

    // Simulate "process restart": new state, replay captured records, and
    // also re-freeze any ids we observed in restored messages.
    const onRecordSpy = vi.fn();
    const restored = new ContentReplacementState({ onRecord: onRecordSpy });
    for (const rec of captured) restored.seedFromResume(rec);
    // Frozen ids come from walking restored response_items in real life;
    // simulate that here.
    restored.freezeUnreplaced('call_c');

    // seenIds and replacements match the originals.
    expect(restored.seenIds.has('call_a')).toBe(true);
    expect(restored.seenIds.has('call_b')).toBe(true);
    expect(restored.seenIds.has('call_c')).toBe(true);
    expect(restored.replacements.get('call_a')).toBe('<persisted-output>A</persisted-output>');
    expect(restored.replacements.get('call_b')).toBe('<persisted-output>B</persisted-output>');
    expect(restored.replacements.has('call_c')).toBe(false);

    // Resume must NOT re-emit any onRecord — otherwise rollout would
    // double-write everything every resume.
    expect(onRecordSpy).not.toHaveBeenCalled();
  });

  it('reapply() returns the same string post-resume', () => {
    const original = new ContentReplacementState();
    original.record('shared', '<persisted-output>SHARED</persisted-output>');

    const rec: ContentReplacementRecord = {
      kind: 'tool-result',
      toolUseId: 'shared',
      replacement: '<persisted-output>SHARED</persisted-output>',
    };
    const restored = new ContentReplacementState();
    restored.seedFromResume(rec);

    expect(restored.reapply('shared')).toBe(original.reapply('shared'));
  });
});
