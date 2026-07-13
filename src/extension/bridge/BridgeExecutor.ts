/**
 * Bridge Executor
 *
 * Executes single tool calls dispatched by the desktop app over the bridge —
 * the extension's "pure executor" mode. No LLM loop is involved: calls go
 * straight through a dedicated ToolRegistry populated with the extension's
 * browser tools. Reasoning AND approvals live on the desktop side; this
 * registry deliberately has no ApprovalGate (mirrors the headless server).
 *
 * Tab semantics mirror the extension agent: the executor holds one "current
 * tab" that tools operate on (tools receive it via `request.tabId` →
 * `metadata.tabId`), switched explicitly through the `browser_tabs` tool the
 * executor implements itself. Every tab the bridge works on is claimed in
 * the shared {@link TabLeaseStore} under the bridge's session id, so a
 * concurrently running extension agent session and the desktop-driven
 * session cannot stomp each other's tabs — same-tab contention surfaces as
 * a clean TAB_LEASED error to the desktop model.
 *
 * @module extension/bridge/BridgeExecutor
 */

import { ToolRegistry } from '@/tools/ToolRegistry';
import { registerExtensionTools } from '../tools/registerExtensionTools';
import { TabLeasedError } from '@/core/TabLeaseStore';
import { getTabLeaseStore, getLeaseLifecycleQueue, LEASE_QUEUE_KEY } from '../tools/browser/tabLeaseStore';
import type { NodeToolDescriptor } from '@workx/ws-server';

/** Stable lease/session identity for desktop-driven execution. */
export const BRIDGE_SESSION_ID = 'bridge:desktop';

/** Extension tools that must NOT be advertised — the desktop has its own. */
const EXCLUDED_TOOLS = new Set(['planning_tool', 'web_search', 'setting_tool']);

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

  /** Tool catalog advertised to the desktop (browser tools + browser_tabs). */
  async getCatalog(): Promise<NodeToolDescriptor[]> {
    const registry = await this.ensureRegistry();
    const descriptors: NodeToolDescriptor[] = [
      {
        name: BROWSER_TABS_TOOL,
        description:
          'Manage which browser tab the other browser tools operate on. ' +
          "Use action 'list' to see open tabs, 'select' to bind to an existing tab (tab_id), " +
          "'open' to create a new tab (url), and 'close' to close the currently selected tab. " +
          'You must select or open a tab before using other browser tools.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'select', 'open', 'close'] },
            tab_id: { type: 'number', description: "Tab to select (for action 'select')" },
            url: { type: 'string', description: "URL to open (for action 'open')" },
          },
          required: ['action'],
        },
      },
    ];
    for (const def of registry.listTools()) {
      if (def.type !== 'function') continue;
      const name = def.function.name;
      if (EXCLUDED_TOOLS.has(name)) continue;
      descriptors.push({
        name,
        description: def.function.description ?? '',
        parameters: (def.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      });
    }
    return descriptors;
  }

  /** Execute one desktop-dispatched tool call. Never throws — errors are shaped. */
  async execute(
    toolName: string,
    parameters: Record<string, unknown>,
    opts?: { invokeId?: string; timeoutMs?: number },
  ): Promise<BridgeExecutionResult> {
    try {
      if (toolName === BROWSER_TABS_TOOL) {
        return { ok: true, result: await this.handleTabsTool(parameters) };
      }

      const registry = await this.ensureRegistry();
      const tabId = this.currentTabId;
      if (tabId === null) {
        return {
          ok: false,
          error: {
            code: 'NO_TAB_SELECTED',
            message: `No browser tab is selected. Call ${BROWSER_TABS_TOOL} with action 'select' or 'open' first.`,
          },
        };
      }

      // Re-assert the lease before acting: the tab may have been closed (GC)
      // or stolen is impossible (claim by another session throws there, not
      // here) — re-claiming under our own session id just refreshes it.
      await this.claimTab(tabId);

      const response = await registry.execute({
        toolName,
        parameters,
        sessionId: BRIDGE_SESSION_ID,
        turnId: opts?.invokeId ?? `bridge_${Date.now()}`,
        callId: opts?.invokeId,
        tabId,
        timeout: opts?.timeoutMs,
        metadata: { source: 'desktop-bridge' },
      });

      if (response.success) {
        return { ok: true, result: response.data };
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
