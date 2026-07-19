/**
 * Browser Bridge Tool Manager
 *
 * Desktop-runtime side of the extension browser bridge. Watches the
 * app-server {@link NodeBridge} for connected browser-executor nodes (the
 * WorkX Chrome extension in `mode: 'node'`) and mirrors the node's advertised
 * tool catalog into every live agent session's ToolRegistry as proxy tools.
 * Each proxy forwards the call over the bridge and returns the executor's
 * result.
 *
 * Follows the same per-session register/unregister bookkeeping pattern as
 * `ServerAgentBootstrap.registerDesktopHubMcpTools` (gateway MCP tools).
 *
 * Approvals run HERE (desktop side, where the reasoning and the user are);
 * the extension executor trusts already-approved calls — see the bridge
 * design discussion. Risk is assessed with the same browser assessor used
 * for chrome-devtools-mcp tools.
 *
 * @module desktop-runtime/browser-bridge/BrowserBridgeToolManager
 */

import type { NodeToolDescriptor } from '@workx/ws-server';
import type { SessionManager } from '@/core/registry/SessionManager';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import type { JsonSchema, ToolDefinition } from '@/tools/BaseTool';
import type { BrowserBridgeHandle } from '@/tools/browserBridgeHandle';
import { McpBrowserRiskAssessor } from '@/core/approval/assessors/McpBrowserRiskAssessor';
import { NodeInvokeFailure, type NodeBridge } from '@/app-server/node-bridge/NodeBridge';
import type { SessionBrowserContext } from '@/core/platform/IPlatformAdapter';

export interface BrowserBridgeToolManagerDeps {
  nodeBridge: NodeBridge;
  getRegistry: () => SessionManager | null;
}

/** Metadata reads must stay fast; the actual browser tool owns the long budget. */
export const BROWSER_CONTEXT_TIMEOUT_MS = 3_000;
/** Session cleanup is best-effort and must not stall suspension or shutdown. */
export const BROWSER_RELEASE_TIMEOUT_MS = 1_000;

export class BrowserBridgeToolManager implements BrowserBridgeHandle {
  /** Tool names this manager registered, per session (for clean unregister). */
  private registeredBySession = new Map<string, string[]>();
  private unsubscribe: (() => void) | null = null;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BrowserBridgeToolManagerDeps) {}

  /** Start reacting to node connect/advertise/disconnect. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.nodeBridge.onNodesChanged(() => {
      // Serialize syncs — a connect immediately followed by a disconnect must
      // not interleave register/unregister across sessions.
      this.syncing = this.syncing
        .then(() => this.syncAllSessions())
        .catch((err) => {
          console.error('[BrowserBridgeToolManager] session sync failed:', err);
        });
    });
  }

  async detach(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Queue cleanup after any in-flight catalog sync. Otherwise an app-server
    // restart can leave proxy tools registered with closures over the old,
    // permanently disconnected NodeBridge.
    this.syncing = this.syncing
      .catch((err) => {
        console.error('[BrowserBridgeToolManager] pending session sync failed during detach:', err);
      })
      .then(() => this.unregisterAllSessions());
    await this.syncing;
  }

  hasActiveNode(): boolean {
    return this.deps.nodeBridge.getPrimaryNode() !== null;
  }

  /** Re-sync bridge tools on every live session. */
  async syncAllSessions(): Promise<void> {
    const registry = this.deps.getRegistry();
    if (!registry) return;

    for (const meta of registry.listSessions()) {
      if (meta.state === 'terminated') continue;
      const agentSession = registry.getSession(meta.sessionId);
      const toolRegistry = agentSession?.agent?.getToolRegistry?.();
      if (!toolRegistry) continue;
      try {
        await this.applyToRegistry(meta.sessionId, toolRegistry);
      } catch (err) {
        console.warn(
          `[BrowserBridgeToolManager] bridge tool sync failed for session ${meta.sessionId}:`,
          err,
        );
      }
    }
  }

  /**
   * Make one session's registry reflect the current bridge state: remove
   * previously registered bridge tools, then register the primary node's
   * catalog (if any). Safe to call for brand-new sessions.
   */
  async applyToRegistry(sessionId: string, toolRegistry: ToolRegistry): Promise<void> {
    const previous = this.registeredBySession.get(sessionId) ?? [];
    for (const name of previous) {
      try {
        await toolRegistry.unregister(name);
      } catch {
        // Already gone — fine.
      }
    }
    this.registeredBySession.delete(sessionId);

    const node = this.deps.nodeBridge.getPrimaryNode();
    if (!node) return;

    const assessor = new McpBrowserRiskAssessor();
    const registered: string[] = [];
    for (const tool of node.tools) {
      // Never clobber a natively registered tool of the same name.
      if (toolRegistry.getTool(tool.name)) continue;
      await toolRegistry.register(
        this.definitionFor(tool),
        (params) => this.invoke(sessionId, tool.name, params),
        assessor,
      );
      registered.push(tool.name);
    }
    if (registered.length > 0) {
      this.registeredBySession.set(sessionId, registered);
    }
    console.log(
      `[BrowserBridgeToolManager] session ${sessionId}: ${registered.length} bridge browser tools registered from ${node.displayName || node.clientId}`,
    );
  }

  /** Drop bookkeeping for a session that no longer exists. */
  forgetSession(sessionId: string): void {
    this.registeredBySession.delete(sessionId);
  }

  async getSessionBrowserContext(sessionId: string): Promise<SessionBrowserContext | null> {
    const result = await this.invokeOperation(
      sessionId,
      'browser-context',
      BROWSER_CONTEXT_TIMEOUT_MS,
    );
    if (!result || typeof result !== 'object') return null;
    const context = result as Partial<SessionBrowserContext>;
    return typeof context.tabId === 'number'
      && typeof context.url === 'string'
      && typeof context.hostname === 'string'
      ? context as SessionBrowserContext
      : null;
  }

  async releaseSession(sessionId: string): Promise<void> {
    try {
      await this.invokeOperation(sessionId, 'release-session', BROWSER_RELEASE_TIMEOUT_MS);
    } finally {
      this.forgetSession(sessionId);
    }
  }

  private async unregisterAllSessions(): Promise<void> {
    const registry = this.deps.getRegistry();
    if (!registry) {
      this.registeredBySession.clear();
      return;
    }

    for (const [sessionId, names] of this.registeredBySession) {
      const toolRegistry = registry.getSession(sessionId)?.agent?.getToolRegistry?.();
      if (toolRegistry) {
        for (const name of names) {
          try {
            await toolRegistry.unregister(name);
          } catch {
            // Session/tool already disposed — bookkeeping can still be dropped.
          }
        }
      }
      this.registeredBySession.delete(sessionId);
    }
  }

  private definitionFor(tool: NodeToolDescriptor): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        strict: false,
        // Advertised schemas arrive as plain JSON over the wire; trust the
        // executor's shape (same boundary cast as MCP tool registration).
        parameters: (tool.parameters ?? { type: 'object', properties: {} }) as JsonSchema,
      },
      metadata: {
        platforms: ['desktop'],
        source: 'browser-bridge',
        readOnlyHint: tool.readOnly,
      },
    };
  }

  private async invoke(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Resolve the node at call time — the connection may have cycled since
    // registration, and the proxy should follow the live one.
    const node = this.deps.nodeBridge.getPrimaryNode();
    if (!node) {
      throw new Error(
        'WorkX browser extension is not connected. Ask the user to open Chrome with the WorkX extension installed and paired.',
      );
    }
    try {
      return await this.deps.nodeBridge.invoke(node.connectionId, toolName, params, {
        operation: 'tool',
        sessionId,
      });
    } catch (err) {
      if (err instanceof NodeInvokeFailure) {
        if (err.error.code === 'FOREGROUND_REQUIRED') {
          const details = err.error.details as { tabId?: unknown; reason?: unknown } | undefined;
          const tabId = Number(details?.tabId);
          const reason = details?.reason === 'login' || details?.reason === 'permission'
            ? details.reason
            : 'user-gesture';
          if (!Number.isInteger(tabId)) {
            throw new Error(`Browser tool '${toolName}' requested foreground without a valid tab`);
          }
          const registry = this.deps.getRegistry();
          if (!registry) throw new Error('Session manager is unavailable for foreground approval');
          const grant = await registry.requestForeground(sessionId, tabId, reason);
          // Retry exactly once, and only because the executor guaranteed no
          // tool side effects occurred before FOREGROUND_REQUIRED.
          return this.deps.nodeBridge.invoke(node.connectionId, toolName, params, {
            operation: 'tool',
            sessionId,
            focusGrantId: grant.grantId,
          });
        }
        throw new Error(`Browser tool '${toolName}' failed: ${err.error.message}`);
      }
      throw err;
    }
  }

  private async invokeOperation(
    sessionId: string,
    operation: 'release-session' | 'browser-context',
    timeoutMs: number,
  ): Promise<unknown> {
    const node = this.deps.nodeBridge.getPrimaryNode();
    if (!node) return null;
    return this.deps.nodeBridge.invoke(
      node.connectionId,
      '',
      {},
      { operation, sessionId, timeoutMs },
    );
  }
}
