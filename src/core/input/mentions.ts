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
 *
 * Security/robustness:
 *  - `@url` is reachable from untrusted origins (connectors/relay). Targets
 *    that resolve to loopback / private / link-local space are refused so the
 *    server cannot be used as an SSRF proxy (e.g. cloud-metadata at
 *    169.254.169.254). DNS-rebinding is out of scope (would require resolving
 *    + pinning); the IP-literal/localhost block stops the common vectors.
 *  - Every resolution is bounded by RESOLUTION_TIMEOUT_MS so a hung URL/tab
 *    cannot stall the submission (the funnel is awaited before the turn).
 */

import type { InputItem } from '../protocol/types';
import type { FunnelContext } from './types';
import { buildPersistedOutputMessage } from '../../tools/resultStore';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../tools/toolLimits';
import { fingerprint } from './hash';

/** Hard bound on any single mention resolution (fetch / page / selection). */
export const RESOLUTION_TIMEOUT_MS = 8000;

export type Mention =
  | { kind: 'tab'; tabId?: number }
  | { kind: 'page' }
  | { kind: 'selection' }
  | { kind: 'url'; addr: string };

/** Strip wrapping/trailing punctuation so `(@tab)`, `@page.`, `@url,` parse. */
function normalizeToken(tok: string): string {
  return tok.replace(/^[("'<]+/, '').replace(/[)"'>.,;:!?]+$/, '');
}

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
    const tok = normalizeToken(tokens[i]);
    if (!tok.startsWith('@')) continue;
    if (tok === '@page') add({ kind: 'page' }, 'page');
    else if (tok === '@selection') add({ kind: 'selection' }, 'selection');
    else if (tok === '@tab') add({ kind: 'tab' }, 'tab');
    else if (/^@tab:.+$/.test(tok)) {
      const raw = tok.slice('@tab:'.length);
      const id = Number(raw);
      if (Number.isFinite(id)) add({ kind: 'tab', tabId: id }, `tab:${id}`);
    } else if (tok === '@url') {
      const addr = normalizeToken(tokens[i + 1] ?? '');
      if (addr && /^https?:\/\//i.test(addr)) {
        add({ kind: 'url', addr }, `url:${addr}`);
        i++; // consume the address token
      }
    }
  }
  return out;
}

/** Reject loopback / private / link-local / unspecified targets (SSRF). */
export function blockedUrlReason(addr: string): string | null {
  let url: URL;
  try {
    url = new URL(addr);
  } catch {
    return 'malformed URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported protocol ${url.protocol}`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'loopback host';
  }
  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return 'invalid IPv4';
    const [a, b] = o;
    if (
      a === 0 || // 0.0.0.0/8
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local incl. cloud metadata
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    ) {
      return 'private/loopback/link-local IPv4';
    }
    return null;
  }
  // IPv6 literal
  if (host.includes(':')) {
    if (
      host === '::1' || // loopback
      host === '::' || // unspecified
      host.startsWith('fe80') || // link-local
      host.startsWith('fc') || // unique-local fc00::/7
      host.startsWith('fd') ||
      host.includes('::ffff:127.') || // IPv4-mapped loopback
      host.includes('::ffff:169.254.')
    ) {
      return 'private/loopback/link-local IPv6';
    }
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${RESOLUTION_TIMEOUT_MS}ms`)),
        RESOLUTION_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Turn resolved content into an InputItem: inline when small, a Track-09
 *  <persisted-output> marker when large (mirrors Phase 2's collapse so the
 *  conversation is never flooded; the model reads the rest on demand). The
 *  persistence id is content-addressed → idempotent across replays. */
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
      `mention-${label}-${fingerprint(content)}`,
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
        // Capability-independent — works headless, so reachable from
        // untrusted connectors. Refuse internal targets (SSRF).
        const blocked = blockedUrlReason(m.addr);
        if (blocked) {
          notes.push(`@url ${m.addr} — refused (${blocked}).`);
          continue;
        }
        const res = await fetch(m.addr, {
          signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
          redirect: 'follow',
        });
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
        m.kind === 'tab' && m.tabId !== undefined ? m.tabId : ctx.tabId ?? -1;
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
        const sel = (
          await withTimeout(controller.getSelectionText(), '@selection')
        ).trim();
        if (!sel) {
          notes.push('@selection — nothing is selected on the page.');
          continue;
        }
        items.push(await materialize('selection', '', sel, ctx));
        continue;
      }

      // @page / @tab / @tab:<id>
      const content = await withTimeout(
        controller.getPageContent(),
        `@${m.kind}`,
      );
      const attrs =
        m.kind === 'tab' && m.tabId !== undefined ? ` tab="${m.tabId}"` : '';
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
