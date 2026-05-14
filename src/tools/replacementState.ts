/**
 * ContentReplacementState — tracks per-tool_use_id persistence decisions so
 * replayed turns produce byte-identical wire bytes (preserves prompt cache).
 *
 * Port of Claudy's ContentReplacementState (utils/toolResultStorage.ts:390-393).
 * Lives on Session; mutated by TurnManager during tier-1 and tier-2 persistence.
 * Replacement decisions are surfaced to the rollout recorder via the optional
 * `onRecord` callback so they survive compaction and resume.
 */

/**
 * A single replacement decision persisted to the rollout. On resume, the
 * stored `replacement` string is re-applied verbatim — never regenerated —
 * so template changes can't silently invalidate the cache.
 */
export interface ContentReplacementRecord {
  kind: 'tool-result';
  toolUseId: string;
  replacement: string;
}

export interface ContentReplacementStateOptions {
  /**
   * Called after every successful `record()`. Used by Session to write a
   * `content_replacement` rollout item so the decision survives resume.
   * Deliberately NOT called by `seedFromResume`, which is the inverse path.
   */
  onRecord?(rec: ContentReplacementRecord): void;
}

export class ContentReplacementState {
  /** All tool_use_ids whose persistence fate has been decided this session. */
  readonly seenIds = new Set<string>();
  /** tool_use_id → exact preview string the model saw. Byte-identical re-apply. */
  readonly replacements = new Map<string, string>();

  constructor(private opts: ContentReplacementStateOptions = {}) {}

  /**
   * Record a fresh persistence decision: the model saw `replacement` for
   * `callId`. Adds to both seenIds and replacements, and notifies the rollout.
   */
  record(callId: string, replacement: string): void {
    this.seenIds.add(callId);
    this.replacements.set(callId, replacement);
    this.opts.onRecord?.({ kind: 'tool-result', toolUseId: callId, replacement });
  }

  /**
   * Reseed state from a rollout record loaded on resume. Same semantics as
   * `record` but deliberately bypasses `onRecord` — otherwise resume would
   * re-write everything back to the rollout.
   */
  seedFromResume(rec: ContentReplacementRecord): void {
    this.seenIds.add(rec.toolUseId);
    this.replacements.set(rec.toolUseId, rec.replacement);
  }

  /**
   * Freeze a decision as "seen but unreplaced" — used for Infinity-opt-out
   * tools (their results passed through unchanged the first time and must
   * stay unchanged across replay) and for tier-2 entries that fit under
   * budget without persistence.
   */
  freezeUnreplaced(callId: string): void {
    this.seenIds.add(callId);
  }

  /**
   * On a replayed turn, look up the cached replacement string. If present,
   * the caller skips the store entirely and reuses this. Returns undefined
   * for never-seen or seen-but-unreplaced ids.
   */
  reapply(callId: string): string | undefined {
    return this.replacements.get(callId);
  }
}
