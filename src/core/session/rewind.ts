/**
 * Track 15 — Conversation Rewind & Fork: pure core slice logic.
 *
 * This module is intentionally UI/transport-independent. It only reads the
 * source rollout via the RolloutRecorder storage provider and returns a
 * `forked` InitialHistory payload. It does NOT flush the source session,
 * create sessions, or call the model — callers are responsible for:
 *   - D13: flushing the live source session (`Session.flushRollout()`) BEFORE
 *     invoking these functions, so queued-but-unflushed turns are visible;
 *   - feeding the returned `{mode:'forked',...}` into the registry fork seam
 *     (`SessionConfig.fork`);
 *   - supplying a `summarize` implementation for `buildSummarizedFork`
 *     (D9 — model client is injected by the platform, never constructed here).
 *
 * Correctness invariants:
 *   - D2: a user-turn boundary slice never bisects a tool-call/result pair
 *     (the writer persists them in one atomic batch before the next user
 *     item), but selector/checkpoint values may not land exactly on one.
 *   - D11: `pairingTrim` makes the slice well-formed for ANY targetSequence
 *     and ANY caller (selector, Plan Review, server, scheduler) so the first
 *     post-rewind model request can never contain an unpaired tool call.
 */

import { RolloutRecorder } from '@/storage/rollout';
import type { RolloutItem } from '@/storage/rollout/types';
import type { ResponseItem } from '@/core/protocol/types';

/** A selectable user turn in the source conversation. */
export interface RewindTurn {
  /** RolloutItem.sequence of the user message — the rewind target. */
  sequence: number;
  /** Short preview for UI lists. */
  preview: string;
  /** Full user-message text (for input repopulation, D8). */
  text: string;
}

/** The `forked` InitialHistory payload consumed by `SessionConfig.fork`. */
export interface ForkedHistory {
  mode: 'forked';
  rolloutItems: RolloutItem[];
  sourceConversationId: string;
}

/** Summarizer injected by the platform (D9). Returns undefined on failure. */
export type RewindSummarizer = (items: ResponseItem[]) => Promise<string | undefined>;

const PREVIEW_LEN = 120;

function firstText(payload: any): string {
  const c = payload?.content?.[0];
  return typeof c?.text === 'string' ? c.text : '';
}

async function readSortedRecords(
  sourceConversationId: string,
): Promise<Array<{ sequence: number; type: string; payload: any }>> {
  const provider = await RolloutRecorder.getProvider();
  const records = await provider.getItemsByRolloutId(sourceConversationId);
  // Defensive sort: the Tauri provider does not guarantee JS-side ordering.
  return [...records].sort((a, b) => a.sequence - b.sequence);
}

function messageHasContent(payload: any): boolean {
  const content = payload?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((c: any) => {
    if (c && typeof c === 'object' && 'text' in c) {
      return String(c.text ?? '').trim().length > 0;
    }
    return !!c;
  });
}

/**
 * D11 — drop any tool call whose result was sliced off (and vice-versa) so the
 * reconstructed history is a well-formed model request regardless of where the
 * slice boundary fell. Covers: standalone `function_call`, the unified
 * assistant `message.tool_calls[]` shape, and orphan `function_call_output`.
 */
export function pairingTrim(items: RolloutItem[]): RolloutItem[] {
  const completed = new Set<string>(); // function_call_output.call_id present
  const called = new Set<string>(); // call ids that have a call in the slice

  for (const it of items) {
    if (it.type !== 'response_item') continue;
    const p: any = it.payload;
    if (p?.type === 'function_call_output' && typeof p.call_id === 'string') {
      completed.add(p.call_id);
    } else if (p?.type === 'function_call' && typeof p.call_id === 'string') {
      called.add(p.call_id);
    } else if (p?.type === 'message' && Array.isArray(p.tool_calls)) {
      for (const tc of p.tool_calls) {
        if (typeof tc?.id === 'string') called.add(tc.id);
      }
    }
  }

  const out: RolloutItem[] = [];
  for (const it of items) {
    if (it.type !== 'response_item') {
      out.push(it);
      continue;
    }
    const p: any = it.payload;

    if (p?.type === 'function_call') {
      if (typeof p.call_id === 'string' && completed.has(p.call_id)) out.push(it);
      // else: unpaired call → drop
      continue;
    }

    if (p?.type === 'function_call_output') {
      if (typeof p.call_id === 'string' && called.has(p.call_id)) out.push(it);
      // else: orphan output → drop
      continue;
    }

    if (p?.type === 'message' && Array.isArray(p.tool_calls) && p.tool_calls.length > 0) {
      const keptCalls = p.tool_calls.filter(
        (tc: any) => typeof tc?.id === 'string' && completed.has(tc.id),
      );
      if (keptCalls.length === p.tool_calls.length) {
        out.push(it);
      } else if (keptCalls.length === 0 && !messageHasContent(p)) {
        // message existed only to carry now-unpaired tool calls → drop
        continue;
      } else {
        // strip the unpaired tool calls, keep the message + any matched calls
        const trimmed = { ...p };
        if (keptCalls.length > 0) trimmed.tool_calls = keptCalls;
        else delete trimmed.tool_calls;
        out.push({ ...it, payload: trimmed });
      }
      continue;
    }

    out.push(it);
  }
  return out;
}

/**
 * List the user turns of `sourceConversationId` (ascending by sequence) so a
 * selector / remote operator can pick a rewind point. Caller MUST have flushed
 * the live source session first (D13).
 */
export async function listUserTurns(sourceConversationId: string): Promise<RewindTurn[]> {
  const records = await readSortedRecords(sourceConversationId);
  const turns: RewindTurn[] = [];
  for (const r of records) {
    if (
      r.type === 'response_item' &&
      r.payload?.type === 'message' &&
      r.payload?.role === 'user'
    ) {
      const text = firstText(r.payload);
      turns.push({ sequence: r.sequence, preview: text.slice(0, PREVIEW_LEN), text });
    }
  }
  return turns;
}

/**
 * D10 — the scheduler "last successful checkpoint": the greatest USER
 * `response_item` sequence that is `<= max(assistant response_item sequence)`.
 * Backing up to a user-turn boundary keeps only fully-batched turns (the only
 * dangle-free boundary). Returns null when the job failed before producing any
 * assistant turn (caller falls back to a plain bounded retry / retry-from-zero).
 */
export async function findCheckpointSequence(
  sourceConversationId: string,
): Promise<number | null> {
  const records = await readSortedRecords(sourceConversationId);
  let maxAssistant = -1;
  for (const r of records) {
    if (
      r.type === 'response_item' &&
      r.payload?.type === 'message' &&
      r.payload?.role === 'assistant'
    ) {
      if (r.sequence > maxAssistant) maxAssistant = r.sequence;
    }
  }
  if (maxAssistant < 0) return null;
  let checkpoint: number | null = null;
  for (const r of records) {
    if (
      r.type === 'response_item' &&
      r.payload?.type === 'message' &&
      r.payload?.role === 'user' &&
      r.sequence <= maxAssistant
    ) {
      checkpoint = r.sequence; // records are ascending → last match is greatest
    }
  }
  return checkpoint;
}

/**
 * Pure slice: everything at `sequence <= targetSequence`, source `session_meta`
 * dropped (the new rollout writes its own), defensively sorted, D11-trimmed.
 * Caller MUST have flushed the live source session first (D13).
 */
export async function computeRewindSlice(
  sourceConversationId: string,
  targetSequence: number,
): Promise<ForkedHistory> {
  const records = await readSortedRecords(sourceConversationId);
  const sliced = records
    .filter((r) => r.sequence <= targetSequence
      && r.type !== 'session_meta'
      && r.type !== 'turn_start'
      && r.type !== 'turn_completion')
    .map((r) => ({ type: r.type, payload: r.payload }) as RolloutItem);
  return {
    mode: 'forked',
    rolloutItems: pairingTrim(sliced),
    sourceConversationId,
  };
}

/**
 * `summarize_up_to`: compact the ENTIRE `<= targetSequence` slice into ONE
 * `compacted` item (D5). On reconstruct that becomes a single system message
 * persisted as a normal response_item in the new rollout. If summarization
 * yields nothing, fall back to the plain (trimmed) slice so the rewind still
 * succeeds.
 */
export async function buildSummarizedFork(
  sourceConversationId: string,
  targetSequence: number,
  summarize: RewindSummarizer,
): Promise<ForkedHistory> {
  const base = await computeRewindSlice(sourceConversationId, targetSequence);
  const responseItems = base.rolloutItems
    .filter((i) => i.type === 'response_item')
    .map((i) => (i as Extract<RolloutItem, { type: 'response_item' }>).payload as ResponseItem);

  const summary = responseItems.length > 0 ? await summarize(responseItems) : undefined;
  if (!summary) return base;

  return {
    mode: 'forked',
    rolloutItems: [{ type: 'compacted', payload: { message: summary } }],
    sourceConversationId,
  };
}
