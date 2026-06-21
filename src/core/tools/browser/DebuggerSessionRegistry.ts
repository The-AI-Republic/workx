/**
 * Debugger Session Registry
 *
 * Centralizes Chrome debugger attachment so that the multiple services that
 * operate a tab (DomService, ScreenshotService, CoordinateActionService) share
 * a SINGLE underlying `chrome.debugger` attachment per tab instead of each
 * attaching independently.
 *
 * Why this exists (see `.ai_design/improve_webtool_from_codex/design.md` §3.1):
 * chrome.debugger allows only one debugger client per tab, yet today three
 * services each attach independently with a racy `Runtime.evaluate('1+1')`
 * probe, and the screenshot services never detach. The agent loop runs up to
 * `MAX_SAFE_TOOL_CALL_CONCURRENCY` concurrency-safe tool calls in parallel
 * (e.g. `browser_dom` snapshot + `page_vision` screenshot on the same tab), so
 * these uncoordinated attaches genuinely race.
 *
 * The registry hands out a refcounted {@link DebuggerHandle}. The shared
 * attachment is established on first `acquire` and torn down when the last
 * holder `release`s. A single `chrome.debugger.onDetach` reconciler (owned by
 * the implementation) keeps registry state consistent when the user closes the
 * debugger infobar or the tab dies.
 *
 * @module core/tools/browser/DebuggerSessionRegistry
 */

import type { DebuggerClient } from './DebuggerClient';

/**
 * Called when the shared session for a tab detaches outside our control
 * (debugger infobar closed, tab navigated away/closed, or a forced detach).
 *
 * @param reason - chrome.debugger detach reason, or `'force_detach'`.
 */
export type DebuggerDetachCallback = (reason: string) => void;

/**
 * A refcounted handle to a shared per-tab debugger session.
 *
 * Extends {@link DebuggerClient} so existing consumers that already program
 * against that interface need minimal changes. Note that {@link release} — not
 * `detach` — is what relinquishes this holder's reference; `detach()` is kept
 * only for interface compatibility and is an alias for `release()`.
 */
export interface DebuggerHandle extends DebuggerClient {
  /** The tab this handle is bound to. */
  readonly tabId: number;

  /**
   * Subscribe to external/forced detach of the shared session. The callback
   * fires at most once for a given detach. Returns an unsubscribe function.
   */
  onDetach(callback: DebuggerDetachCallback): () => void;

  /**
   * Decrement the shared session's refcount; the underlying tab is detached
   * when the count reaches zero. Idempotent (a second call is a no-op) and
   * NEVER throws.
   */
  release(): Promise<void>;
}

/**
 * Owns the shared per-tab debugger attachments.
 */
export interface DebuggerSessionRegistry {
  /**
   * Attach to the tab if not already attached (idempotent, serialized per tab),
   * and increment the refcount. Returns a handle scoped to this acquisition.
   *
   * @throws Error with an `ALREADY_ATTACHED:` prefix when a foreign debugger
   *   (e.g. DevTools) holds the tab.
   */
  acquire(tabId: number): Promise<DebuggerHandle>;

  /**
   * Tear down the shared session immediately, ignoring refcounts and detach
   * errors: clears registry state first, then detaches. Outstanding handles'
   * `release()` calls become no-ops. Used on CDP-command timeouts and onDetach
   * reconciliation.
   */
  forceDetach(tabId: number): Promise<void>;

  /** Whether a shared session currently exists for the tab. */
  isAttached(tabId: number): boolean;
}
