/**
 * PageReadiness — event-driven page-load waiting (replaces polling heuristics).
 *
 * Subscribes to CDP `Page.lifecycleEvent`s (enabled via
 * `Page.setLifecycleEventsEnabled`) and resolves `waitFor(state)` when the named
 * lifecycle fires. `networkAlmostIdle`/`networkIdle` come free with lifecycle
 * events — no `Network.enable` needed. Waits are correlated by `loaderId` so a
 * `load` from the *previous* document can't satisfy a wait for the new one.
 *
 * Also forwards `Page.javascriptDialogOpening` so a `confirm()` no longer
 * deadlocks pending CDP evaluates.
 *
 * Design: `.ai_design/improve_webtool_from_codex/design.md` §3.8 / §7.3.
 *
 * @module extension/tools/browser/PageReadiness
 */

import type { DebuggerHandle } from '@/core/tools/browser/DebuggerSessionRegistry';

export type ReadinessState = 'DOMContentLoaded' | 'load' | 'networkAlmostIdle' | 'networkIdle';

export interface WaitForOptions {
  timeoutMs?: number;
  /** When the timeout elapses, resolve instead of reject (default true). */
  failOpen?: boolean;
  /** Only count lifecycle events for this loaderId (set by navigate()). */
  loaderId?: string;
}

export interface DialogInfo {
  type: string;
  message: string;
}

interface Waiter {
  state: ReadinessState;
  loaderId?: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PageReadiness {
  private readonly boundListener: (method: string, params: unknown) => void;
  private readonly ready: Promise<void>;
  /** loaderId → lifecycle names already seen (so a wait registered late still resolves). */
  private readonly seen = new Map<string, Set<string>>();
  private readonly waiters = new Set<Waiter>();
  private readonly dialogCallbacks = new Set<(info: DialogInfo) => void>();
  private latestLoaderId: string | undefined;

  constructor(private readonly handle: DebuggerHandle) {
    this.boundListener = (method, params) => this.onCdpEvent(method, params as any);
    handle.onEvent(this.boundListener);
    this.ready = this.enable();
  }

  private async enable(): Promise<void> {
    await this.handle.enableDomain('Page');
    await this.handle.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true });
  }

  /**
   * Navigate and return correlation ids. Wait against the returned loaderId so
   * only this document's lifecycle events satisfy a subsequent waitFor.
   */
  async navigate(url: string, waitUntil?: ReadinessState, opts?: WaitForOptions): Promise<{ frameId: string; loaderId?: string }> {
    await this.ready;
    const result = await this.handle.sendCommand<{ frameId: string; loaderId?: string; errorText?: string }>(
      'Page.navigate',
      { url }
    );
    if (result.errorText) {
      throw new Error(`NAVIGATION_FAILED: ${result.errorText}`);
    }
    if (waitUntil) {
      await this.waitFor(waitUntil, { ...opts, loaderId: result.loaderId });
    }
    return { frameId: result.frameId, loaderId: result.loaderId };
  }

  /** Resolve when `state` is reached (optionally for a specific loaderId). */
  async waitFor(state: ReadinessState, opts?: WaitForOptions): Promise<void> {
    await this.ready;
    const loaderId = opts?.loaderId ?? this.latestLoaderId;

    // Already seen for this loader? resolve immediately.
    if (loaderId && this.seen.get(loaderId)?.has(state)) return;

    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const failOpen = opts?.failOpen ?? true;

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        state,
        loaderId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          if (failOpen) resolve();
          else reject(new Error(`PAGE_READINESS_TIMEOUT: '${state}' not reached within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Subscribe to javascript dialogs (alert/confirm/prompt/beforeunload). */
  onDialog(cb: (info: DialogInfo) => void): () => void {
    this.dialogCallbacks.add(cb);
    return () => this.dialogCallbacks.delete(cb);
  }

  /** Respond to an open javascript dialog. */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.handle.sendCommand('Page.handleJavaScriptDialog', { accept, promptText });
  }

  dispose(): void {
    this.handle.offEvent(this.boundListener);
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer);
    }
    this.waiters.clear();
    this.dialogCallbacks.clear();
    this.seen.clear();
  }

  private onCdpEvent(method: string, params: any): void {
    if (method === 'Page.lifecycleEvent') {
      const loaderId: string = params.loaderId;
      const name: string = params.name;
      if (loaderId) {
        this.latestLoaderId = loaderId;
        let set = this.seen.get(loaderId);
        if (!set) {
          set = new Set();
          this.seen.set(loaderId, set);
        }
        set.add(name);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.state === name && (!waiter.loaderId || waiter.loaderId === loaderId)) {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve();
        }
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      const info: DialogInfo = { type: params.type, message: params.message };
      for (const cb of this.dialogCallbacks) {
        try {
          cb(info);
        } catch (error) {
          console.error('[PageReadiness] dialog callback error:', error);
        }
      }
    }
  }
}
