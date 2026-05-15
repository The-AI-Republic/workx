/**
 * Track 13 — the core input funnel.
 *
 * `processUserInput` is invoked from `RepublicAgent.submitOperation` for
 * `UserInput`/`UserTurn`, immediately before `preSubmitHooks`, so the
 * `UserPromptSubmit` hook sees expanded input. One placement serves the
 * extension, the desktop app, and all three server input sources.
 *
 * Stage order mirrors claudy's `processUserInputBase` adapted to BrowserX's
 * `InputItem[]` / capability / Track-09 vocabulary
 * (design §4.4). Phases land incrementally:
 *
 *   Phase 1 — normalize · bridge-safe slash gate          (this file)
 *   Phase 2 — wire-image / paste disk-backing             (stage 2)
 *   Phase 3 — @tab/@page/@selection/@url mentions          (stage 6)
 *   Phase 4 — `!` bash escape                              (stage 4)
 *
 * Invariant: the user's primary `text` item is never rewritten — resolved
 * content rides alongside as additional items.
 */

import type { InputItem } from '../protocol/types';
import type { FunnelContext, ProcessedInput } from './types';
import { classifyForOrigin, originRequiresGate } from './bridgeSafe';
import { diskBackOversized } from './diskBacking';
import { parseMentions, resolveMentions } from './mentions';

/** Minimal slash parser (claudy parity / `parseCommandInput` logic).
 *  Inlined so `core/` never imports the `webfront/` UI command module. */
function parseSlash(text: string): { name: string; args?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  if (body === '') return null;
  const sp = body.indexOf(' ');
  if (sp === -1) return { name: body.toLowerCase() };
  return {
    name: body.slice(0, sp).toLowerCase(),
    args: body.slice(sp + 1).trim() || undefined,
  };
}

/** Split items into the primary prompt text and the rest (claudy's
 *  `inputString` vs `precedingInputBlocks`). The last text item is the
 *  prompt; everything else is preserved in order. */
function splitItems(items: InputItem[]): {
  primaryText: string;
  primaryIndex: number;
  rest: InputItem[];
} {
  let primaryIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'text') {
      primaryIndex = i;
      break;
    }
  }
  const primaryText =
    primaryIndex >= 0 ? (items[primaryIndex] as { text: string }).text : '';
  const rest = items.filter((_, i) => i !== primaryIndex);
  return { primaryText, primaryIndex, rest };
}

/**
 * Run the input funnel.
 *
 * Never throws for a capability/permission shortfall — those degrade into a
 * `systemNote` so an unattended connector/scheduler job is never aborted.
 */
export async function processUserInput(
  items: InputItem[],
  ctx: FunnelContext,
): Promise<ProcessedInput> {
  // ── Stage 1: normalize ────────────────────────────────────────────────
  const { primaryText } = splitItems(items);

  // ── Stage 3: bridge-safe slash gate ───────────────────────────────────
  // Only untrusted origins are gated (claudy: only `bridgeOrigin` input).
  if (originRequiresGate(ctx.origin)) {
    const parsed = parseSlash(primaryText);
    if (parsed) {
      const safety = classifyForOrigin(parsed.name);
      if (safety === 'unsafe-known') {
        // Short-circuit: do not forward a raw UI/sensitive command to the
        // model. Mirrors claudy's <local-command-stdout> short-circuit.
        return {
          items,
          shouldQuery: false,
          resultText: `/${parsed.name} isn't available over a ${ctx.origin.channel} channel.`,
          systemNote: `Blocked "/${parsed.name}" from ${ctx.origin.channelType ?? ctx.origin.channel}: command not available over this channel.`,
        };
      }
      // 'safe'  → recognized read-only command; for Phase 1 there is no
      //           server-side executor, so let the text through to the model
      //           (it is harmless and informative).
      // 'unknown' → claudy parity: treat as a plain prompt.
    }
  }

  // ── Stage 2: wire-image / paste disk-backing ──────────────────────────
  const backed = await diskBackOversized(items, ctx);
  const notes: string[] = [...backed.notes];

  // ── Stage 4 (Phase 4): `!` bash escape ────────────────────────────────

  // ── Stage 6: @tab/@page/@selection/@url mentions ──────────────────────
  let resultItems = backed.items;
  const mentions = parseMentions(primaryText);
  if (mentions.length > 0) {
    const resolved = await resolveMentions(mentions, ctx);
    resultItems = [...resultItems, ...resolved.items];
    notes.push(...resolved.notes);
  }

  return {
    items: resultItems,
    shouldQuery: true,
    systemNote: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
