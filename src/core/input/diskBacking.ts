/**
 * Track 13 — funnel Stage 2: disk-back pasted screenshots / wire images and
 * collapse oversized text pastes (design §4.4.2, §7.4).
 *
 * Track 09's `ToolResultStore.persist` is a *string* store, so a binary image
 * is stored as a small JSON envelope `{ mime, b64 }`. The decision deferred to
 * the design's Phase-2 spike (§7.4) is resolved here as the safe hybrid:
 *
 *   - The inline `image` item is KEPT so the model's vision pipeline still
 *     sees the screenshot this turn (claudy parity: the image block is still
 *     passed; only a metadata breadcrumb is added — never a file-read of the
 *     base64, which would dump the blob back into the prompt as text).
 *   - The blob is additionally persisted for transcript/replay durability and
 *     a short `[Image source: <ref>]` breadcrumb is appended.
 *
 * Large text/`clipboard` pastes ARE collapsed: the content is persisted and
 * replaced with Track 09's `<persisted-output>` preview + retrieval message,
 * so the conversation is not flooded.
 *
 * Never throws: a persistence failure leaves the item unchanged and records a
 * note, so an unattended connector/scheduler job is never aborted.
 */

import type { InputItem } from '../protocol/types';
import type { FunnelContext } from './types';
import { buildPersistedOutputMessage } from '../../tools/resultStore';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../tools/toolLimits';
import { fingerprint } from './hash';

function parseDataUri(uri: string): { mime: string; b64: string } | null {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(uri);
  if (!m) return null;
  return { mime: m[1] || 'image/png', b64: m[2] };
}

export interface DiskBackResult {
  items: InputItem[];
  /** Non-fatal notes (e.g. a persistence failure). */
  notes: string[];
}

export async function diskBackOversized(
  items: InputItem[],
  ctx: FunnelContext,
): Promise<DiskBackResult> {
  const store = ctx.resultStore;
  const out: InputItem[] = [];
  const notes: string[] = [];
  let pasteSeq = 0;

  for (const item of items) {
    // ── Screenshots / wire images ─────────────────────────────────────
    if (item.type === 'image') {
      out.push(item); // keep inline — vision must still see it this turn
      const parsed = parseDataUri(item.image_url);
      if (parsed && store) {
        try {
          const toolUseId = `paste-${fingerprint(parsed.b64)}`;
          const persisted = await store.persist(
            ctx.sessionId,
            toolUseId,
            JSON.stringify({ mime: parsed.mime, b64: parsed.b64 }),
          );
          out.push({
            type: 'text',
            text: `[Image source: ${persisted.reference} (${parsed.mime})]`,
          });
        } catch (err) {
          notes.push(
            `Could not persist a pasted image (${
              err instanceof Error ? err.message : 'unknown error'
            }); it is still attached to this turn.`,
          );
        }
      }
      continue;
    }

    // ── Oversized text / clipboard paste ──────────────────────────────
    if (
      item.type === 'clipboard' &&
      typeof item.content === 'string' &&
      item.content.length > DEFAULT_MAX_RESULT_SIZE_CHARS
    ) {
      pasteSeq++;
      if (store) {
        try {
          const toolUseId = `paste-${fingerprint(item.content)}`;
          const persisted = await store.persist(
            ctx.sessionId,
            toolUseId,
            item.content,
          );
          out.push({
            type: 'text',
            text: `[Pasted text #${pasteSeq}]\n${buildPersistedOutputMessage(
              persisted,
            )}`,
          });
          continue;
        } catch (err) {
          notes.push(
            `Could not collapse a large paste (${
              err instanceof Error ? err.message : 'unknown error'
            }); it was kept inline.`,
          );
        }
      }
      // No store, or persist failed: fall through keeping the item as-is
      // (convertInputItem maps clipboard → text downstream).
      out.push(item);
      continue;
    }

    out.push(item);
  }

  return { items: out, notes };
}
