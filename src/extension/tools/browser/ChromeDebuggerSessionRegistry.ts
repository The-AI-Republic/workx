/**
 * Chrome Debugger Session Registry
 *
 * Extension-mode implementation of {@link DebuggerSessionRegistry}. Owns one
 * shared {@link ChromeDebuggerClient} per tab, refcounted, with attach/detach
 * serialized by a per-tab async mutex.
 *
 * @module extension/tools/browser/ChromeDebuggerSessionRegistry
 */

import { ChromeDebuggerClient } from './ChromeDebuggerClient';
import type { CDPDomain, CDPEventCallback, DebuggerTarget } from '@/core/tools/browser/DebuggerClient';
import {
  CdpCommandTimeoutError,
  type DebuggerHandle,
  type DebuggerSessionRegistry,
  type DebuggerDetachCallback,
  type SendCommandOptions,
} from '@/core/tools/browser/DebuggerSessionRegistry';

/** Default per-command timeout for interactive commands. */
const DEFAULT_CDP_TIMEOUT_MS = 10_000;
/** Short timeout for input dispatch — a wedged Input.* is unambiguous. */
const INPUT_CDP_TIMEOUT_MS = 5_000;
/**
 * Longer budget for snapshot-heavy commands that can legitimately take many
 * seconds on large pages. Well under DomService's overall `snapshotTimeout`
 * (120s) but enough to catch a genuinely wedged renderer.
 */
const SLOW_CDP_TIMEOUT_MS = 60_000;
const SLOW_METHODS = new Set<string>([
  'DOM.getDocument',
  'Accessibility.getFullAXTree',
  'DOMSnapshot.captureSnapshot',
  'Page.captureScreenshot',
]);

function defaultTimeoutForMethod(method: string): number {
  if (SLOW_METHODS.has(method)) return SLOW_CDP_TIMEOUT_MS;
  if (method.startsWith('Input.')) return INPUT_CDP_TIMEOUT_MS;
  return DEFAULT_CDP_TIMEOUT_MS;
}

/**
 * Race a promise against a timeout that rejects with `onTimeout()`. The timer is
 * always cleared so it can't fire after the command settled. A late underlying
 * resolution is harmless — a JS promise can only settle once.
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Per-tab shared session state. */
interface TabSession {
  client: ChromeDebuggerClient;
  refs: number;
  /** Detach subscribers across all live handles for this tab. */
  detachCallbacks: Set<DebuggerDetachCallback>;
}

export class ChromeDebuggerSessionRegistry implements DebuggerSessionRegistry {
  private sessions = new Map<number, TabSession>();
  /** Per-tab promise-chain mutex. Tail never rejects (see {@link withTabLock}). */
  private locks = new Map<number, Promise<unknown>>();
  private detachListener:
    | ((source: chrome.debugger.Debuggee, reason: string) => void)
    | null = null;

  constructor() {
    this.installDetachListener();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  async acquire(tabId: number): Promise<DebuggerHandle> {
    return this.withTabLock(tabId, async () => {
      let session = this.sessions.get(tabId);
      if (!session) {
        const client = new ChromeDebuggerClient();
        try {
          await client.attach({ tabId } as DebuggerTarget);
        } catch (error: any) {
          const message = String(error?.message ?? error);
          if (message.toLowerCase().includes('already attached')) {
            throw new Error(
              'ALREADY_ATTACHED: DevTools is open on this tab. Please close DevTools.'
            );
          }
          throw new Error(`ATTACH_FAILED: ${message}`);
        }
        session = { client, refs: 0, detachCallbacks: new Set() };
        this.sessions.set(tabId, session);
      }
      session.refs++;
      return this.makeHandle(tabId, session);
    });
  }

  async forceDetach(tabId: number): Promise<void> {
    return this.withTabLock(tabId, async () => {
      const session = this.sessions.get(tabId);
      this.sessions.delete(tabId);
      if (!session) return;
      this.notifyDetach(session, 'force_detach');
      try {
        await session.client.detach();
      } catch {
        /* ignore — session is being torn down regardless */
      }
    });
  }

  isAttached(tabId: number): boolean {
    return this.sessions.has(tabId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Release one reference held by `owned`; detach the shared session at
   * refcount zero. The identity check (`session !== owned`) makes a release from
   * a handle whose session was already force/externally detached (and possibly
   * replaced by a re-acquire) a no-op — otherwise it would decrement/detach an
   * unrelated session bound to the same tabId.
   */
  private releaseTab(tabId: number, owned: TabSession): Promise<void> {
    return this.withTabLock(tabId, async () => {
      const session = this.sessions.get(tabId);
      if (!session || session !== owned) return;
      session.refs--;
      if (session.refs <= 0) {
        this.sessions.delete(tabId);
        try {
          await session.client.detach();
        } catch {
          /* ignore */
        }
      }
    });
  }

  /**
   * Per-tab async mutex. Each call is chained after the previous one settles
   * (success OR failure), so a rejected operation cannot poison the chain for
   * later waiters. The stored "tail" is a non-rejecting promise; the returned
   * promise preserves the operation's own result/rejection for the caller.
   */
  private withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(tabId, tail);
    // Garbage-collect the lock entry once this tail settles, unless a newer
    // operation has already superseded it.
    void tail.then(() => {
      if (this.locks.get(tabId) === tail) {
        this.locks.delete(tabId);
      }
    });
    return run;
  }

  private notifyDetach(session: TabSession, reason: string): void {
    for (const cb of session.detachCallbacks) {
      try {
        cb(reason);
      } catch (error) {
        console.error('[DebuggerSessionRegistry] detach callback error:', error);
      }
    }
    session.detachCallbacks.clear();
  }

  private installDetachListener(): void {
    if (typeof chrome === 'undefined' || !chrome.debugger?.onDetach) {
      return; // Non-extension context (e.g. tests, desktop) — nothing to reconcile.
    }
    this.detachListener = (source, reason) => {
      const tabId = source.tabId;
      if (tabId == null) return;
      void this.handleExternalDetach(tabId, reason);
    };
    chrome.debugger.onDetach.addListener(this.detachListener);
  }

  /** Reconcile state when chrome reports a detach we did not initiate. */
  private async handleExternalDetach(tabId: number, reason: string): Promise<void> {
    await this.withTabLock(tabId, async () => {
      const session = this.sessions.get(tabId);
      if (!session) return;
      this.sessions.delete(tabId);
      this.notifyDetach(session, reason);
      // The chrome-side session is already gone; best-effort cleanup of our
      // client's listeners/state.
      try {
        await session.client.detach();
      } catch {
        /* ignore */
      }
    });
  }

  private makeHandle(tabId: number, session: TabSession): DebuggerHandle {
    const registry = this;
    const client = session.client;
    let released = false;
    // Track this handle's own subscriptions so release() can clean them up
    // from the shared client without disturbing sibling handles.
    const ownEventCallbacks: CDPEventCallback[] = [];
    const ownDetachCallbacks: DebuggerDetachCallback[] = [];

    const handle: DebuggerHandle = {
      tabId,

      // ── DebuggerClient: lifecycle ──
      // attach is a no-op: the registry owns attachment.
      attach: async () => {},
      detach: () => handle.release(),
      isAttached: () => !released && registry.sessions.has(tabId),

      // ── DebuggerClient: commands ──
      // Each command is raced against a per-method timeout. On timeout the tab
      // is presumed wedged and force-detached so the next acquire re-attaches
      // clean. NOTE (blast radius): force-detach abandons ALL in-flight commands
      // on the shared tab, so one timed-out command fails its concurrent
      // siblings too. Acceptable for a wedged renderer; see design §1.6 #2.
      sendCommand: async <T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        opts?: SendCommandOptions
      ): Promise<T> => {
        const timeoutMs = opts?.timeoutMs ?? defaultTimeoutForMethod(method);
        try {
          return await raceWithTimeout(
            client.sendCommand<T>(method, params),
            timeoutMs,
            () => new CdpCommandTimeoutError(method, timeoutMs)
          );
        } catch (error) {
          if (error instanceof CdpCommandTimeoutError) {
            await registry.forceDetach(tabId);
          }
          throw error;
        }
      },

      // ── DebuggerClient: events / domains ──
      onEvent: (cb: CDPEventCallback) => {
        ownEventCallbacks.push(cb);
        client.onEvent(cb);
      },
      offEvent: (cb: CDPEventCallback) => {
        const i = ownEventCallbacks.indexOf(cb);
        if (i !== -1) ownEventCallbacks.splice(i, 1);
        client.offEvent(cb);
      },
      enableDomain: (domain: CDPDomain) => client.enableDomain(domain),
      disableDomain: (domain: CDPDomain) => client.disableDomain(domain),

      // ── DebuggerClient: convenience ──
      getTargetInfo: () => client.getTargetInfo(),
      getTabId: () => tabId,

      // ── DebuggerHandle extensions ──
      onDetach: (cb: DebuggerDetachCallback) => {
        session.detachCallbacks.add(cb);
        ownDetachCallbacks.push(cb);
        return () => {
          session.detachCallbacks.delete(cb);
        };
      },
      release: async () => {
        if (released) return;
        released = true;
        // Remove this handle's subscriptions from the shared client/session.
        for (const cb of ownEventCallbacks) client.offEvent(cb);
        for (const cb of ownDetachCallbacks) session.detachCallbacks.delete(cb);
        // Pass the captured session so we only decrement OUR session, never a
        // replacement bound to the same tabId after a force/external detach.
        await registry.releaseTab(tabId, session);
      },
    };

    return handle;
  }

  /** Test-only: detach the global onDetach listener (paired with reset). */
  _dispose(): void {
    if (this.detachListener && typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
      chrome.debugger.onDetach.removeListener(this.detachListener);
    }
    this.detachListener = null;
    this.sessions.clear();
    this.locks.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton — both DomService and the screenshot services import from here so
// they coordinate through ONE registry instance.
// ─────────────────────────────────────────────────────────────────────────────

let registrySingleton: ChromeDebuggerSessionRegistry | null = null;

export function getDebuggerSessionRegistry(): ChromeDebuggerSessionRegistry {
  if (!registrySingleton) {
    registrySingleton = new ChromeDebuggerSessionRegistry();
  }
  return registrySingleton;
}

/**
 * Test-only: drop the singleton so each test starts with a clean registry.
 * Wired into the global test setup's `beforeEach`.
 */
export function __resetDebuggerSessionRegistryForTests(): void {
  registrySingleton?._dispose();
  registrySingleton = null;
}
