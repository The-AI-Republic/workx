/**
 * Bridge Executor
 *
 * Executes single tool calls dispatched by the desktop app over the bridge —
 * the extension's "pure executor" mode. No LLM loop is involved: calls go
 * straight through a dedicated ToolRegistry populated with the extension's
 * browser tools. Reasoning AND approvals live on the desktop side; this
 * registry deliberately has no ApprovalGate (mirrors the headless server).
 *
 * The desktop sees ONE advertised tool — `local_browser_tool` — whose
 * `action` param fans out to the executor's own tabs handler or to the
 * underlying registry tools (browser_dom, browser_navigation,
 * data_extraction). See localBrowserTool.ts for the mapping and rationale.
 * The underlying tools are reachable only through the facade, so tools that
 * must never be desktop-driven (setting_tool, page_vision, planning_tool,
 * web_search) are excluded simply by not being mapped.
 *
 * Tab semantics mirror the extension agent: the executor holds one "current
 * tab" that tools operate on (tools receive it via `request.tabId` →
 * `metadata.tabId`), switched explicitly through the facade's tab actions.
 * Every tab the bridge works on is claimed in the shared
 * {@link TabGroupRegistry} under the bridge's session id, so a concurrently
 * running extension agent session and the desktop-driven session cannot
 * stomp each other's tabs — same-tab contention surfaces as a clean
 * TAB_LEASED error to the desktop model.
 *
 * @module extension/bridge/BridgeExecutor
 */

import { ToolRegistry } from '@/tools/ToolRegistry';
import { registerExtensionTools } from '../tools/registerExtensionTools';
import { ExtensionPlatformAdapter } from '../platform/ExtensionPlatformAdapter';
import { getTabGroupRegistry, TabOwnedByAnotherSessionError } from '../platform/TabGroupRegistry';
import type { NodeToolDescriptor } from '@workx/ws-server';
import {
  LOCAL_BROWSER_TOOL,
  localBrowserToolDescriptor,
  mapLocalBrowserAction,
} from './localBrowserTool';

/**
 * Cap one node.result payload well below the app-server's 1 MB default
 * frame limit (ws closes the connection on oversize frames — a huge scrape
 * result must degrade into a truncated preview, not kill the bridge).
 */
const MAX_RESULT_BYTES = 768 * 1024;
const TRUNCATED_PREVIEW_CODE_UNITS = 64 * 1024;

function truncatedResult(preview: string, originalBytes: number | null, reason: string): unknown {
  return {
    truncated: true,
    original_bytes: originalBytes,
    preview: preview.slice(0, TRUNCATED_PREVIEW_CODE_UNITS),
    note: reason,
  };
}

/** Shrink oversized tool results to a truncated preview envelope. */
export function capResultPayload(result: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(result) ?? 'null';
  } catch {
    return truncatedResult(
      String(result),
      null,
      'Result was not JSON-serializable; this is a safe string preview. Narrow the request and try again.',
    );
  }
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength <= MAX_RESULT_BYTES) return result;
  return truncatedResult(
    json,
    byteLength,
    `Result was ${byteLength} bytes and exceeded the bridge payload limit; ` +
      'this is a truncated JSON preview. Narrow the request (e.g. scrape a selector, paginate the extraction).',
  );
}

/** The executor-implemented tab management tool. */
const BROWSER_TABS_TOOL = 'browser_tabs';

export interface BridgeExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export class BridgeExecutor {
  private readonly registries = new Map<string, ToolRegistry>();
  private readonly adapters = new Map<string, ExtensionPlatformAdapter>();
  private readonly currentTabIds = new Map<string, number>();
  private readonly initPromises = new Map<string, Promise<ToolRegistry>>();
  private readonly pendingForeground = new Map<string, { tabId: number; reason: 'user-gesture' }>();

  /** Lazily build the dedicated tool registry (no approval gate — see module doc). */
  private ensureRegistry(sessionId: string): Promise<ToolRegistry> {
    const current = this.registries.get(sessionId);
    if (current) return Promise.resolve(current);
    const existing = this.initPromises.get(sessionId);
    if (existing) return existing;
    const promise = (async () => {
        const adapter = new ExtensionPlatformAdapter(sessionId);
        await adapter.initialize();
        const registry = new ToolRegistry();
        await registerExtensionTools(
          registry,
          { enable_all_tools: true },
          // supportsImage: screenshots are returned as data for the desktop
          // model to consume; the desktop side decides what to do with them.
          { name: 'bridge-executor', supportsImage: true },
          adapter.browserResources,
        );
        this.adapters.set(sessionId, adapter);
        this.registries.set(sessionId, registry);
        return registry;
      })();
    this.initPromises.set(sessionId, promise);
    const clearPromise = () => this.initPromises.delete(sessionId);
    void promise.then(clearPromise, clearPromise);
    return promise;
  }

  /**
   * Tool catalog advertised to the desktop: exactly ONE tool. The desktop
   * model drives every browser capability through local_browser_tool's
   * `action` param — see localBrowserTool.ts for the consolidation rationale.
   */
  async getCatalog(): Promise<NodeToolDescriptor[]> {
    return [localBrowserToolDescriptor()];
  }

  /** Execute one desktop-dispatched tool call. Never throws — errors are shaped. */
  async execute(
    toolName: string,
    parameters: Record<string, unknown>,
    opts?: {
      invokeId?: string;
      timeoutMs?: number;
      operation?: 'tool' | 'release-session' | 'browser-context';
      sessionId?: string;
      focusGrantId?: string;
    },
  ): Promise<BridgeExecutionResult> {
    try {
      const sessionId = opts?.sessionId;
      if (!sessionId) {
        return { ok: false, error: { code: 'SESSION_REQUIRED', message: 'Bridge sessionId is required' } };
      }
      if (opts.operation === 'release-session') {
        await this.releaseSession(sessionId);
        return { ok: true, result: { released: true } };
      }
      if (opts.operation === 'browser-context') {
        return { ok: true, result: await this.getSessionBrowserContext(sessionId) };
      }
      const scopedParameters = { ...parameters };
      // Enforce the advertised surface: the desktop peer is token-trusted,
      // but the executor still refuses anything it never offered (the
      // underlying registry tools are reachable ONLY through the facade).
      if (toolName !== LOCAL_BROWSER_TOOL) {
        return {
          ok: false,
          error: {
            code: 'TOOL_NOT_ADVERTISED',
            message: `Tool '${toolName}' is not available over the desktop bridge. Use '${LOCAL_BROWSER_TOOL}'.`,
          },
        };
      }

      const invocation = mapLocalBrowserAction(scopedParameters);
      if (invocation.target === 'error') {
        return { ok: false, error: { code: invocation.code, message: invocation.message } };
      }
      if (invocation.target === 'tabs') {
        return { ok: true, result: await this.handleTabsTool(sessionId, invocation.params) };
      }

      const registry = await this.ensureRegistry(sessionId);

      if (!this.currentTabIds.has(sessionId)) {
        if (invocation.autoOpenTab) {
          // navigate with no tab selected: open one instead of failing —
          // the tab-first precondition is a footgun for small models.
          await this.handleTabsTool(sessionId, { action: 'open' });
        } else {
          return {
            ok: false,
            error: {
              code: 'NO_TAB_SELECTED',
              message:
                "No browser tab is selected. Use action 'select_tab' or 'open_tab' first " +
                "(or 'navigate', which auto-opens a tab).",
            },
          };
        }
      }
      const tabId = this.currentTabIds.get(sessionId)!;

      const needsForeground = invocation.toolName === 'browser_dom'
        && ['click', 'type', 'keypress'].includes(String(invocation.params.action));
      if (needsForeground) {
        const pending = this.pendingForeground.get(sessionId);
        if (!opts?.focusGrantId) {
          this.pendingForeground.set(sessionId, { tabId, reason: 'user-gesture' });
          return {
            ok: false,
            error: {
              code: 'FOREGROUND_REQUIRED',
              message: 'This browser action needs the user-visible tab in the foreground.',
              details: { tabId, reason: 'user-gesture' },
            },
          };
        }
        if (!pending || pending.tabId !== tabId) {
          return {
            ok: false,
            error: {
              code: 'INVALID_FOCUS_GRANT',
              message: 'The foreground grant does not match this bridge session and tab.',
            },
          };
        }
        // One-shot consumption happens before the authorized focus side effect.
        this.pendingForeground.delete(sessionId);
        await chrome.tabs.update(tabId, { active: true });
      }

      // Re-assert the lease before acting: the tab may have been closed (GC)
      // or stolen is impossible (claim by another session throws there, not
      // here) — re-claiming under our own session id just refreshes it.
      await this.claimTab(sessionId, tabId);

      const response = await registry.execute({
        toolName: invocation.toolName,
        parameters: invocation.params,
        sessionId,
        turnId: opts?.invokeId ?? `bridge_${Date.now()}`,
        callId: opts?.invokeId,
        tabId,
        timeout: opts?.timeoutMs,
        metadata: { source: 'desktop-bridge' },
      });

      if (response.success) {
        return { ok: true, result: capResultPayload(response.data) };
      }
      return {
        ok: false,
        error: {
          code: response.error?.code ?? 'TOOL_ERROR',
          message: response.error?.message ?? 'Tool execution failed',
          details: response.error?.details,
        },
      };
    } catch (err) {
      if (err instanceof TabOwnedByAnotherSessionError) {
        return {
          ok: false,
          error: {
            code: 'TAB_LEASED',
            message:
              `Tab ${err.tabId} is in use by another WorkX session (${err.ownerSessionId}). ` +
              'Pick a different tab or open a new one.',
          },
        };
      }
      return {
        ok: false,
        error: { code: 'EXECUTOR_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Release all bridge-held tab leases (desktop disconnected / bridge disabled). */
  async releaseAll(): Promise<void> {
    const sessionIds = [...this.currentTabIds.keys()];
    await Promise.allSettled(sessionIds.map((sessionId) => this.releaseSession(sessionId)));
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.currentTabIds.delete(sessionId);
    this.pendingForeground.delete(sessionId);
    this.registries.delete(sessionId);
    await this.adapters.get(sessionId)?.dispose().catch(() => undefined);
    this.adapters.delete(sessionId);
  }

  async getSessionBrowserContext(sessionId: string): Promise<{
    tabId: number;
    url: string;
    hostname: string;
  } | null> {
    const tabId = this.currentTabIds.get(sessionId);
    if (tabId === undefined) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !/^https?:/i.test(tab.url)) return null;
      return { tabId, url: tab.url, hostname: new URL(tab.url).hostname };
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // browser_tabs
  // ───────────────────────────────────────────────────────────────────────

  private async handleTabsTool(
    sessionId: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    const action = parameters.action as string;
    switch (action) {
      case 'list': {
        const tabs = await chrome.tabs.query({});
        const groups = getTabGroupRegistry();
        const entries = await Promise.all(
          tabs
            .filter((t) => typeof t.id === 'number')
            .map(async (t) => {
              const owner = await groups.ownerOf(t.id!).catch(() => null);
              return {
                tab_id: t.id!,
                title: t.title ?? '',
                url: t.url ?? '',
                active: t.active === true,
                window_id: t.windowId,
                in_use_by_other_session: owner !== null && owner !== sessionId,
              };
            }),
        );
        return { tabs: entries, current_tab_id: this.currentTabIds.get(sessionId) ?? null };
      }
      case 'select': {
        const tabId = Number(parameters.tab_id);
        if (!Number.isInteger(tabId)) {
          throw new Error("action 'select' requires a numeric tab_id");
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
        await this.ensureRegistry(sessionId);
        await this.claimTab(sessionId, tabId, 'user');
        await this.adapters.get(sessionId)!.browserResources.setCurrent(tabId);
        this.currentTabIds.set(sessionId, tabId);
        return { selected: true, tab_id: tabId, title: tab.title ?? '', url: tab.url ?? '' };
      }
      case 'open': {
        const url = typeof parameters.url === 'string' && parameters.url.length > 0 ? parameters.url : 'about:blank';
        // Do not steal the user's focus — CDP-driven tools work on background tabs.
        await this.ensureRegistry(sessionId);
        const tab = await this.adapters.get(sessionId)!.browserResources.create({ url, active: false });
        this.currentTabIds.set(sessionId, tab.tabId);
        return { opened: true, tab_id: tab.tabId, url };
      }
      case 'close': {
        const tabId = this.currentTabIds.get(sessionId);
        if (tabId === undefined) throw new Error('No tab is currently selected');
        await this.adapters.get(sessionId)?.browserResources.close(tabId).catch(() => undefined);
        this.currentTabIds.delete(sessionId);
        return { closed: true, tab_id: tabId };
      }
      default:
        throw new Error(`Unknown ${BROWSER_TABS_TOOL} action: ${String(action)}`);
    }
  }

  private async claimTab(
    sessionId: string,
    tabId: number,
    origin: 'agent' | 'user' = 'agent',
  ): Promise<void> {
    await this.ensureRegistry(sessionId);
    const resources = this.adapters.get(sessionId)!.browserResources;
    await resources.claimExisting(tabId, origin);
  }
}
