/**
 * ensureContentScript — make sure the content script is live in a tab.
 *
 * Ping-or-inject (design §3.5): ping the tab; on no reply, programmatically
 * inject `content.js` (`injectImmediately`, isolated world — not subject to page
 * CSP) and re-ping. Concurrent calls for the same tab are deduped. Re-injecting
 * a tab that already has the script is harmless — the content script guards with
 * `window.__workx_content_script_loaded__`.
 *
 * Fixes the silent no-op when visual effects target a tab whose content script
 * never loaded (CSP at document_start, tabs open before install, file://).
 *
 * @module extension/background/ensureContentScript
 */

const PING_TIMEOUT_MS = 300;
const inflight = new Map<number, Promise<boolean>>();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function ping(tabId: number): Promise<boolean> {
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'WORKX_PING' }) as Promise<unknown>,
      PING_TIMEOUT_MS
    );
    return res != null;
  } catch {
    return false;
  }
}

async function inject(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      injectImmediately: true,
    });
  } catch (error) {
    console.warn(`[ensureContentScript] inject failed for tab ${tabId}:`, error);
    return false;
  }
  return ping(tabId);
}

export async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await ping(tabId)) return true;

  let pending = inflight.get(tabId);
  if (!pending) {
    pending = inject(tabId).finally(() => inflight.delete(tabId));
    inflight.set(tabId, pending);
  }
  return pending;
}

/** Test-only: clear the in-flight dedupe map. */
export function __resetEnsureContentScriptForTests(): void {
  inflight.clear();
}
