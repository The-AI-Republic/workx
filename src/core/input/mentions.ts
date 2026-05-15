/**
 * Track 13 — funnel Stage 6: browser-native @-mentions (design §4.4.6, §6.3).
 *
 *   @tab            → the bound tab's page content
 *   @tab:<id>       → a specific tab's page content
 *   @page           → the current page content
 *   @selection      → the live text selection on the page
 *   @url <addr>     → fetch/scrape a URL (capability-independent)
 *
 * Invariant: the user's prompt text is NEVER spliced — resolved content is
 * appended as additional items (claudy parity: content rides alongside). Each
 * mention is capability-gated against the *live* IPlatformAdapter flags;
 * an unmet capability degrades into a `systemNote` and the mention is dropped
 * — never a throw (an unattended scheduler/connector job must not abort).
 */

import type { InputItem } from '../protocol/types';
import type { FunnelContext } from './types';
import { buildPersistedOutputMessage } from '../../tools/resultStore';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../tools/toolLimits';

export type Mention =
  | { kind: 'tab'; tabId?: number }
  | { kind: 'page' }
  | { kind: 'selection' }
  | { kind: 'url'; addr: string };

/**
 * Token-scan the prompt for mentions. Token-based (not regex-splice) so the
 * prompt is read, never rewritten. `@url` consumes the following token as its
 * address. Duplicates are de-duplicated (resolution is expensive).
 */
export function parseMentions(text: string): Mention[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (m: Mention, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('@')) continue;
    if (tok === '@page') add({ kind: 'page' }, 'page');
    else if (tok === '@selection') add({ kind: 'selection' }, 'selection');
    else if (tok === '@tab') add({ kind: 'tab' }, 'tab');
    else if (/^@tab:.+$/.test(tok)) {
      const raw = tok.slice('@tab:'.length);
      const id = Number(raw);
      if (Number.isFinite(id)) add({ kind: 'tab', tabId: id }, `tab:${id}`);
    } else if (tok === '@url') {
      const addr = tokens[i + 1];
      if (addr && /^https?:\/\//i.test(addr)) {
        add({ kind: 'url', addr }, `url:${addr}`);
        i++; // consume the address token
      }
    }
  }
  return out;
}

/** Turn resolved content into an InputItem: inline when small, a Track-09
 *  <persisted-output> marker when large (mirrors Phase 2's collapse so the
 *  conversation is never flooded; the model reads the rest on demand). */
async function materialize(
  label: string,
  attrs: string,
  content: string,
  ctx: FunnelContext,
): Promise<InputItem> {
  if (content.length <= DEFAULT_MAX_RESULT_SIZE_CHARS || !ctx.resultStore) {
    const capped =
      content.length > DEFAULT_MAX_RESULT_SIZE_CHARS
        ? content.slice(0, DEFAULT_MAX_RESULT_SIZE_CHARS)
        : content;
    return { type: 'text', text: `<${label}${attrs}>\n${capped}\n</${label}>` };
  }
  try {
    const persisted = await ctx.resultStore.persist(
      ctx.sessionId,
      `mention-${label}-${Date.now()}`,
      content,
    );
    return {
      type: 'text',
      text: `<${label}${attrs}>\n${buildPersistedOutputMessage(persisted)}\n</${label}>`,
    };
  } catch {
    return {
      type: 'text',
      text: `<${label}${attrs}>\n${content.slice(0, DEFAULT_MAX_RESULT_SIZE_CHARS)}\n</${label}>`,
    };
  }
}

export interface ResolveResult {
  /** Items to append alongside the prompt. */
  items: InputItem[];
  /** Degradation notices for dropped mentions. */
  notes: string[];
}

export async function resolveMentions(
  mentions: Mention[],
  ctx: FunnelContext,
): Promise<ResolveResult> {
  const items: InputItem[] = [];
  const notes: string[] = [];

  for (const m of mentions) {
    try {
      if (m.kind === 'url') {
        // Capability-independent — works headless.
        const res = await fetch(m.addr);
        if (!res.ok) {
          notes.push(`@url ${m.addr} — fetch failed (HTTP ${res.status}).`);
          continue;
        }
        const body = await res.text();
        items.push(await materialize('url', ` src="${m.addr}"`, body, ctx));
        continue;
      }

      // Browser-backed mentions: gate on LIVE capability flags.
      if (!ctx.platform.hasBrowserTools) {
        notes.push(
          `@${m.kind} unavailable — no browser attached to this session.`,
        );
        continue;
      }
      if (m.kind === 'tab' && !ctx.platform.hasRealTabs) {
        notes.push('@tab unavailable — this platform has no real tabs.');
        continue;
      }

      const tabId =
        m.kind === 'tab' && m.tabId !== undefined
          ? m.tabId
          : ctx.tabId ?? -1;
      const controller = await ctx.platform.getBrowserController(tabId);
      if (!controller) {
        notes.push(
          `@${m.kind} unavailable — no browser controller for this session.`,
        );
        continue;
      }

      if (m.kind === 'selection') {
        if (!controller.getSelectionText) {
          notes.push('@selection unavailable on this platform.');
          continue;
        }
        const sel = (await controller.getSelectionText()).trim();
        if (!sel) {
          notes.push('@selection — nothing is selected on the page.');
          continue;
        }
        items.push(await materialize('selection', '', sel, ctx));
        continue;
      }

      // @page / @tab / @tab:<id>
      const content = await controller.getPageContent();
      const attrs =
        m.kind === 'tab' && m.tabId !== undefined
          ? ` tab="${m.tabId}"`
          : '';
      items.push(
        await materialize(m.kind === 'tab' ? 'tab' : 'page', attrs, content, ctx),
      );
    } catch (err) {
      notes.push(
        `@${m.kind} could not be resolved (${
          err instanceof Error ? err.message : 'unknown error'
        }).`,
      );
    }
  }

  return { items, notes };
}
