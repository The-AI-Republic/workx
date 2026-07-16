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
 * {@link TabLeaseStore} under the bridge's session id, so a concurrently
 * running extension agent session and the desktop-driven session cannot
 * stomp each other's tabs — same-tab contention surfaces as a clean
 * TAB_LEASED error to the desktop model.
 *
 * @module extension/bridge/BridgeExecutor
 */

import { ToolRegistry } from '@/tools/ToolRegistry';
import { registerExtensionTools } from '../tools/registerExtensionTools';
import { TabLeasedError } from '@/core/TabLeaseStore';
import { getTabLeaseStore, getLeaseLifecycleQueue, LEASE_QUEUE_KEY } from '../tools/browser/tabLeaseStore';
import type { NodeToolDescriptor } from '@workx/ws-server';
import {
  LOCAL_BROWSER_TOOL,
  localBrowserToolDescriptor,
  mapLocalBrowserAction,
} from './localBrowserTool';

/** Stable lease/session identity for desktop-driven execution. */
export const BRIDGE_SESSION_ID = 'bridge:desktop';

/**
 * Cap one node.result payload well below the app-server's 1 MB default
 * frame limit (ws closes the connection on oversize frames — a huge scrape
 * result must degrade into a truncated preview, not kill the bridge).
 */
const MAX_RESULT_BYTES = 768 * 1024;
const TRUNCATED_PREVIEW_BYTES = 64 * 1024;

/** Shrink oversized tool results to a truncated preview envelope. */
export function capResultPayload(result: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(result) ?? 'null';
  } catch {
    json = String(result);
  }
  if (json.length <= MAX_RESULT_BYTES) return result;
  return {
    truncated: true,
    original_bytes: json.length,
    preview: json.slice(0, TRUNCATED_PREVIEW_BYTES),
    note:
      `Result was ${json.length} bytes and exceeded the bridge payload limit; ` +
      'this is a truncated JSON preview. Narrow the request (e.g. scrape a selector, paginate the extraction).',
  };
}

/** The executor-implemented tab management tool. */
const BROWSER_TABS_TOOL = 'browser_tabs';

export interface BridgeExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export class BridgeExecutor {
  private registry: ToolRegistry | null = null;
  private currentTabId: number | null = null;
  private initPromise: Promise<ToolRegistry> | null = null;

  /** Lazily build the dedicated tool registry (no approval gate — see module doc). */
  private ensureRegistry(): Promise<ToolRegistry> {
    if (this.registry) return Promise.resolve(this.registry);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const registry = new ToolRegistry();
        await registerExtensionTools(
          registry,
          { enable_all_tools: true },
          // supportsImage: screenshots are returned as data for the desktop
          // model to consume; the desktop side decides what to do with them.
          { name: 'bridge-executor', supportsImage: true },
        );
        this.registry = registry;
        return registry;
      })();
    }
    return this.initPromise;
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
    opts?: { invokeId?: string; timeoutMs?: number },
  ): Promise<BridgeExecutionResult> {
    try {
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

      const invocation = mapLocalBrowserAction(parameters);
      if (invocation.target === 'error') {
        return { ok: false, error: { code: invocation.code, message: invocation.message } };
      }
      if (invocation.target === 'tabs') {
        return { ok: true, result: await this.handleTabsTool(invocation.params) };
      }

      const registry = await this.ensureRegistry();

      if (this.currentTabId === null) {
        if (invocation.autoOpenTab) {
          // navigate with no tab selected: open one instead of failing —
          // the tab-first precondition is a footgun for small models.
          await this.handleTabsTool({ action: 'open' });
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
      const tabId = this.currentTabId!;

      // Re-assert the lease before acting: the tab may have been closed (GC)
      // or stolen is impossible (claim by another session throws there, not
      // here) — re-claiming under our own session id just refreshes it.
      await this.claimTab(tabId);

      const response = await registry.execute({
        toolName: invocation.toolName,
        parameters: invocation.params,
        sessionId: BRIDGE_SESSION_ID,
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
      if (err instanceof TabLeasedError) {
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
    this.currentTabId = null;
    try {
      await getLeaseLifecycleQueue().run(LEASE_QUEUE_KEY, () =>
        getTabLeaseStore().releaseAll(BRIDGE_SESSION_ID),
      );
    } catch (err) {
      console.warn('[BridgeExecutor] lease release failed:', err);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // browser_tabs
  // ───────────────────────────────────────────────────────────────────────

  private async handleTabsTool(parameters: Record<string, unknown>): Promise<unknown> {
    const action = parameters.action as string;
    switch (action) {
      case 'list': {
        const tabs = await chrome.tabs.query({});
        const store = getTabLeaseStore();
        const entries = await Promise.all(
          tabs
            .filter((t) => typeof t.id === 'number')
            .map(async (t) => {
              const owner = await store.getOwner(t.id!).catch(() => null);
              return {
                tab_id: t.id!,
                title: t.title ?? '',
                url: t.url ?? '',
                active: t.active === true,
                window_id: t.windowId,
                in_use_by_other_session: owner !== null && owner !== BRIDGE_SESSION_ID,
              };
            }),
        );
        return { tabs: entries, current_tab_id: this.currentTabId };
      }
      case 'select': {
        const tabId = Number(parameters.tab_id);
        if (!Number.isInteger(tabId)) {
          throw new Error("action 'select' requires a numeric tab_id");
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) throw new Error(`Tab ${tabId} not found`);
        await this.claimTab(tabId);
        this.currentTabId = tabId;
        return { selected: true, tab_id: tabId, title: tab.title ?? '', url: tab.url ?? '' };
      }
      case 'open': {
        const url = typeof parameters.url === 'string' && parameters.url.length > 0 ? parameters.url : 'about:blank';
        // Do not steal the user's focus — CDP-driven tools work on background tabs.
        const tab = await chrome.tabs.create({ url, active: false });
        if (typeof tab.id !== 'number') throw new Error('Failed to create tab');
        await this.claimTab(tab.id);
        this.currentTabId = tab.id;
        return { opened: true, tab_id: tab.id, url };
      }
      case 'close': {
        const tabId = this.currentTabId;
        if (tabId === null) throw new Error('No tab is currently selected');
        await chrome.tabs.remove(tabId).catch(() => undefined);
        await getLeaseLifecycleQueue().run(LEASE_QUEUE_KEY, () =>
          getTabLeaseStore().release(BRIDGE_SESSION_ID, tabId),
        );
        this.currentTabId = null;
        return { closed: true, tab_id: tabId };
      }
      default:
        throw new Error(`Unknown ${BROWSER_TABS_TOOL} action: ${String(action)}`);
    }
  }

  private claimTab(tabId: number): Promise<void> {
    return getLeaseLifecycleQueue().run(LEASE_QUEUE_KEY, () =>
      getTabLeaseStore().claim({ tabId, sessionId: BRIDGE_SESSION_ID, origin: 'agent' }),
    );
  }
}
