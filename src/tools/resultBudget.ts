/**
 * Tier-2: per-message aggregate budget enforcement (track 09).
 *
 * Even if every individual tool result passes tier-1 (under its per-tool
 * threshold), N parallel calls can collectively flood the conversation —
 * 5 × 50K = 250K of output in a single turn. tier-2 enforces a turn-level
 * aggregate budget on the assembled batch.
 *
 * Decisions are partitioned by prior fate (mustReapply / frozen / fresh) so
 * replayed turns produce byte-identical wire bytes — that's what keeps the
 * prompt cache warm across compaction and resume.
 */

import type { ResponseItem } from '../core/protocol/types';
import { ContentReplacementState } from './replacementState';
import {
  buildPersistedOutputMessage,
  type PersistedResultOwner,
  type ToolResultStore,
} from './resultStore';

/**
 * Narrowed alias for the function_call_output variant of ResponseItem.
 * WorkX doesn't have a dedicated FunctionCallOutput type, so we extract
 * the discriminant here.
 */
export type FunctionCallOutputItem = Extract<ResponseItem, { type: 'function_call_output' }>;

/**
 * Optional resolver from call_id → tool name. Tier-2 needs this to skip
 * Infinity-opt-out tools by name (their call_ids don't carry the tool name).
 * Callers that don't have this mapping can omit it; the budget enforcer
 * will then treat every fresh result as a candidate.
 */
export type ToolNameByCallId = (callId: string) => string | undefined;

export interface EnforceToolResultBudgetOptions {
  store: ToolResultStore;
  sessionId: string;
  /** Per-message aggregate budget in chars; defaults to MAX_TOOL_RESULTS_PER_MESSAGE_CHARS. */
  limit: number;
  /** Tool names whose results should never be persisted (opt-out via Infinity). */
  skipToolNames: ReadonlySet<string>;
  /** Optional call_id → tool_name resolver for the skip-list. */
  toolNameByCallId?: ToolNameByCallId;
  /** Optional call_id → persisted-result owner metadata. */
  ownerByCallId?: (callId: string) => PersistedResultOwner | undefined;
}

/**
 * Enforce the per-message aggregate budget on a batch of tool results.
 *
 *   - mustReapply: id is already in state.replacements → swap output to the
 *     stored replacement (byte-identical, no I/O).
 *   - frozen:      id is in state.seenIds but not replacements → leave alone.
 *   - fresh:       never-seen → eligible for new decisions.
 *
 * If `frozenSize + freshSize <= limit`, everything fresh gets
 * freezeUnreplaced() and the original outputs flow through.
 *
 * Otherwise, sort fresh by size descending and persist the largest until
 * the running total drops below the limit. Mutations to state happen after
 * all awaits resolve, so a concurrent reader cannot see a half-applied
 * decision.
 *
 * Per-result persistence failures freeze the id as seen-but-unreplaced and
 * leave its output unchanged. The budget may remain over after such a
 * failure — that's accepted; we'd rather have an oversize turn than a
 * crashed one.
 */
export async function enforceToolResultBudget(
  results: FunctionCallOutputItem[],
  state: ContentReplacementState | undefined,
  opts: EnforceToolResultBudgetOptions,
): Promise<FunctionCallOutputItem[]> {
  if (!state || results.length === 0) return results;

  // Phase 1: classify each result by prior decision and apply mustReapply.
  const mustReapply: Array<{ idx: number; replacement: string }> = [];
  const frozen: number[] = [];
  const fresh: number[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r || r.type !== 'function_call_output') continue;
    const callId = r.call_id;
    const cached = state.reapply(callId);
    if (cached !== undefined) {
      mustReapply.push({ idx: i, replacement: cached });
    } else if (state.seenIds.has(callId)) {
      frozen.push(i);
    } else {
      fresh.push(i);
    }
  }

  // Apply mustReapply now (cheap, no I/O).
  const next = results.slice();
  for (const { idx, replacement } of mustReapply) {
    const r = next[idx];
    if (r && r.type === 'function_call_output') {
      next[idx] = { ...r, output: replacement };
    }
  }

  // Partition fresh into skip vs eligible.
  const skip: number[] = [];
  const eligible: number[] = [];
  for (const idx of fresh) {
    const r = next[idx];
    if (!r || r.type !== 'function_call_output') continue;
    const toolName = opts.toolNameByCallId?.(r.call_id);
    if (toolName && opts.skipToolNames.has(toolName)) {
      skip.push(idx);
    } else {
      eligible.push(idx);
    }
  }

  // Skip-list ids are frozen immediately (decision sticks across turns).
  for (const idx of skip) {
    const r = next[idx];
    if (r && r.type === 'function_call_output') state.freezeUnreplaced(r.call_id);
  }

  // Size accounting uses the CURRENT output length — which is the preview
  // size for mustReapply entries (already swapped), and the raw output for
  // frozen + eligible.
  const sizeOf = (idx: number): number => {
    const r = next[idx];
    return r && r.type === 'function_call_output' ? r.output.length : 0;
  };

  const frozenSize =
    frozen.reduce((s, i) => s + sizeOf(i), 0) +
    mustReapply.reduce((s, m) => s + sizeOf(m.idx), 0);
  const eligibleSize = eligible.reduce((s, i) => s + sizeOf(i), 0);

  if (frozenSize + eligibleSize <= opts.limit) {
    // Within budget — freeze every eligible id as seen-but-unreplaced so the
    // same decision sticks across replay.
    for (const idx of eligible) {
      const r = next[idx];
      if (r && r.type === 'function_call_output') state.freezeUnreplaced(r.call_id);
    }
    return next;
  }

  // Over budget — select largest fresh entries to persist until under limit.
  const sorted = eligible.slice().sort((a, b) => sizeOf(b) - sizeOf(a));
  const selected: number[] = [];
  let running = frozenSize + eligibleSize;
  for (const idx of sorted) {
    if (running <= opts.limit) break;
    selected.push(idx);
    running -= sizeOf(idx);
  }

  // Persist selected in parallel. State mutations happen post-await so a
  // concurrent reader can't see a half-applied decision.
  const persistResults = await Promise.all(
    selected.map(async (idx) => {
      const r = next[idx];
      if (!r || r.type !== 'function_call_output') return { idx, error: 'invalid' };
      try {
        const persisted = await opts.store.persist(opts.sessionId, r.call_id, r.output, {
          owner: opts.ownerByCallId?.(r.call_id),
        });
        const message = buildPersistedOutputMessage(persisted);
        return { idx, message };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[resultBudget] tier-2 persistence failed for ${r.call_id}: ${reason}`,
        );
        return { idx, error: reason };
      }
    }),
  );

  for (const res of persistResults) {
    const r = next[res.idx];
    if (!r || r.type !== 'function_call_output') continue;
    if ('message' in res && res.message) {
      state.record(r.call_id, res.message);
      next[res.idx] = { ...r, output: res.message };
    } else {
      // Persist failed — freeze id and leave output unchanged.
      state.freezeUnreplaced(r.call_id);
    }
  }

  // All non-selected eligible entries pass through and get frozen.
  const selectedSet = new Set(selected);
  for (const idx of eligible) {
    if (selectedSet.has(idx)) continue;
    const r = next[idx];
    if (r && r.type === 'function_call_output') state.freezeUnreplaced(r.call_id);
  }

  return next;
}
