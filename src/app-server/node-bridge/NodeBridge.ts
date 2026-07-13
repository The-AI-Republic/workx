/**
 * Node Bridge
 *
 * Server-side coordinator for `mode: 'node'` app-server connections — worker
 * clients (first consumer: the WorkX Chrome extension) that advertise tools
 * the desktop agent can invoke remotely. Owns:
 *
 *   - the registry of connected nodes and their advertised tool catalogs,
 *   - reverse RPC: `invoke()` sends a `node.invoke` event to the node and
 *     resolves when the matching `node.result` arrives (or times out),
 *   - change notifications so the host can register/unregister proxy tools.
 *
 * Host-agnostic: knows nothing about ToolRegistry or the desktop runtime.
 *
 * @module app-server/node-bridge/NodeBridge
 */

import { randomUUID } from 'node:crypto';
import {
  NODE_INVOKE_EVENT,
  NodeAdvertiseParamsSchema,
  NodeResultParamsSchema,
  type NodeAdvertiseParams,
  type NodeToolDescriptor,
} from '@workx/ws-server';

export interface ConnectedNode {
  connectionId: string;
  clientId: string;
  kind: string;
  displayName: string;
  version: string;
  tools: NodeToolDescriptor[];
  connectedAt: number;
  /** Send an event frame to this node's connection. */
  sendEvent: (event: string, payload?: unknown) => void;
}

export interface NodeInvokeError {
  code: string;
  message: string;
  details?: unknown;
}

export class NodeInvokeFailure extends Error {
  constructor(public readonly error: NodeInvokeError) {
    super(error.message);
    this.name = 'NodeInvokeFailure';
  }
}

interface PendingInvoke {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
}

export type NodesChangedListener = (nodes: ConnectedNode[]) => void;

/** Default server-side budget for one remote tool call. Browser tools are slow. */
export const DEFAULT_NODE_INVOKE_TIMEOUT_MS = 120_000;

export class NodeBridge {
  private nodes = new Map<string, ConnectedNode>();
  private pending = new Map<string, PendingInvoke>();
  private listeners = new Set<NodesChangedListener>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  // ───────────────────────────────────────────────────────────────────────
  // Connection lifecycle (called by the request processor)
  // ───────────────────────────────────────────────────────────────────────

  /** Track an authenticated node-mode connection (before it advertises). */
  onNodeConnected(params: {
    connectionId: string;
    clientId: string;
    sendEvent: (event: string, payload?: unknown) => void;
  }): void {
    this.nodes.set(params.connectionId, {
      connectionId: params.connectionId,
      clientId: params.clientId,
      kind: 'unknown',
      displayName: '',
      version: '',
      tools: [],
      connectedAt: this.now(),
      sendEvent: params.sendEvent,
    });
    // No notify yet — the node is only useful once it advertises tools.
  }

  /** Drop a node connection; fail its in-flight invokes so callers don't hang. */
  onNodeDisconnected(connectionId: string): void {
    const existed = this.nodes.delete(connectionId);
    for (const [invokeId, p] of this.pending) {
      if (p.connectionId === connectionId) {
        clearTimeout(p.timer);
        this.pending.delete(invokeId);
        p.reject(
          new NodeInvokeFailure({
            code: 'DISCONNECTED',
            message: 'Browser executor disconnected during the call',
          }),
        );
      }
    }
    if (existed) this.notify();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Method handlers (wired by the request processor dispatch)
  // ───────────────────────────────────────────────────────────────────────

  /** Handle `node.advertise` from a connected node. */
  handleAdvertise(connectionId: string, params: unknown): { accepted: true; toolCount: number } {
    const parsed: NodeAdvertiseParams = NodeAdvertiseParamsSchema.parse(params ?? {});
    const node = this.nodes.get(connectionId);
    if (!node) {
      throw new Error('Not a node connection');
    }
    node.kind = parsed.node.kind;
    node.displayName = parsed.node.displayName;
    node.version = parsed.node.version;
    node.tools = parsed.tools;
    this.notify();
    return { accepted: true, toolCount: parsed.tools.length };
  }

  /** Handle `node.result` from a node; resolves the matching invoke. */
  handleResult(connectionId: string, params: unknown): { accepted: boolean } {
    const parsed = NodeResultParamsSchema.parse(params ?? {});
    const p = this.pending.get(parsed.invokeId);
    if (!p || p.connectionId !== connectionId) {
      // Late result after timeout/disconnect — drop silently.
      return { accepted: false };
    }
    clearTimeout(p.timer);
    this.pending.delete(parsed.invokeId);
    if (parsed.ok) {
      p.resolve(parsed.result);
    } else {
      p.reject(
        new NodeInvokeFailure(
          parsed.error ?? { code: 'UNAVAILABLE', message: 'Node reported failure without detail' },
        ),
      );
    }
    return { accepted: true };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────

  /** Nodes that have advertised at least one tool, newest connection last. */
  getActiveNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.tools.length > 0);
  }

  /**
   * The node currently used for browser execution. With multiple paired
   * browsers connected, the most recently connected one wins (deterministic
   * and matches "the browser the user just paired").
   */
  getPrimaryNode(): ConnectedNode | null {
    const active = this.getActiveNodes();
    return active.length > 0 ? active[active.length - 1] : null;
  }

  /** Subscribe to node connect/advertise/disconnect changes. */
  onNodesChanged(listener: NodesChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Invoke a tool on a node and await its result.
   * Rejects with {@link NodeInvokeFailure} on node error, disconnect, or timeout.
   */
  invoke(
    connectionId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const node = this.nodes.get(connectionId);
    if (!node) {
      return Promise.reject(
        new NodeInvokeFailure({ code: 'DISCONNECTED', message: 'Browser executor is not connected' }),
      );
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_NODE_INVOKE_TIMEOUT_MS;
    const invokeId = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invokeId);
        reject(
          new NodeInvokeFailure({
            code: 'AGENT_TIMEOUT',
            message: `Browser executor did not answer within ${timeoutMs}ms`,
          }),
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(invokeId, { resolve, reject, timer, connectionId });
      node.sendEvent(NODE_INVOKE_EVENT, {
        invokeId,
        toolName,
        parameters,
        // Give the executor a slightly smaller budget so its own timeout
        // error (with real context) beats the server's generic one.
        timeoutMs: Math.max(1_000, timeoutMs - 5_000),
      });
    });
  }

  /** Fail all pending invokes and clear state (server shutdown). */
  clear(): void {
    for (const [invokeId, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new NodeInvokeFailure({ code: 'UNAVAILABLE', message: 'App-server stopped' }));
      this.pending.delete(invokeId);
    }
    const hadNodes = this.nodes.size > 0;
    this.nodes.clear();
    if (hadNodes) this.notify();
  }

  private notify(): void {
    const snapshot = this.getActiveNodes();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[NodeBridge] nodes-changed listener failed:', err);
      }
    }
  }
}
