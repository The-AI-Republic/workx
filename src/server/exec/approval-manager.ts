/**
 * Execution Approval Manager
 *
 * Manages approval request/resolve flow with timeout support.
 * Policy modes: always, dangerous, never, allowlist.
 *
 * @module server/exec/approval-manager
 */

import { getServerConfig } from '../config/server-config';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type ApprovalPolicy = 'always' | 'dangerous' | 'never' | 'allowlist';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  command?: string;
  explanation?: string;
  riskLevel: string;
  createdAt: number;
  timeoutMs: number;
  sessionKey?: string;
}

export type ApprovalDecision = 'approve' | 'reject' | 'timeout';

export interface ApprovalResult {
  id: string;
  decision: ApprovalDecision;
  reason?: string;
  resolvedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────
// ApprovalManager
// ─────────────────────────────────────────────────────────────────────────

export class ApprovalManager {
  private pending = new Map<string, {
    request: ApprovalRequest;
    resolve: (result: ApprovalResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private allowlist: Set<string> = new Set();
  private onRequestCallback: ((request: ApprovalRequest) => void) | null = null;

  /**
   * Set callback for when a new approval is requested.
   * This is used to broadcast the request to connected clients.
   */
  onApprovalRequest(cb: (request: ApprovalRequest) => void): void {
    this.onRequestCallback = cb;
  }

  /**
   * Set the tool allowlist (for 'allowlist' policy mode).
   */
  setAllowlist(tools: string[]): void {
    this.allowlist = new Set(tools);
  }

  /**
   * Request approval for a tool execution.
   * Returns a promise that resolves when approved/rejected/timed out.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const config = getServerConfig();
    const policy = config.server.exec.approvalPolicy as ApprovalPolicy;

    // Check policy — some modes don't require interactive approval
    switch (policy) {
      case 'never':
        return {
          id: request.id,
          decision: 'approve',
          reason: 'Policy: never require approval',
          resolvedAt: Date.now(),
        };

      case 'allowlist':
        if (this.allowlist.has(request.toolName)) {
          return {
            id: request.id,
            decision: 'approve',
            reason: 'Tool in allowlist',
            resolvedAt: Date.now(),
          };
        }
        break;

      case 'dangerous':
        // Only require approval for high-risk operations
        if (request.riskLevel !== 'high' && request.riskLevel !== 'critical') {
          return {
            id: request.id,
            decision: 'approve',
            reason: 'Risk level below threshold',
            resolvedAt: Date.now(),
          };
        }
        break;

      case 'always':
        // Always require approval — fall through to interactive flow
        break;
    }

    // Interactive approval flow
    const timeoutMs = request.timeoutMs || config.server.exec.approvalTimeoutMs;

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve({
          id: request.id,
          decision: 'timeout',
          reason: `Approval timed out after ${timeoutMs}ms`,
          resolvedAt: Date.now(),
        });
      }, timeoutMs);

      this.pending.set(request.id, { request, resolve, timer });

      // Notify connected clients
      if (this.onRequestCallback) {
        this.onRequestCallback(request);
      }
    });
  }

  /**
   * Resolve a pending approval request.
   * Returns true if the request existed and was resolved.
   */
  resolveApproval(id: string, decision: 'approve' | 'reject', reason?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(id);

    entry.resolve({
      id,
      decision,
      reason,
      resolvedAt: Date.now(),
    });

    return true;
  }

  /**
   * Get all pending approval requests.
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  /**
   * Cancel all pending approvals (e.g., on shutdown).
   */
  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        id,
        decision: 'reject',
        reason: 'Server shutting down',
        resolvedAt: Date.now(),
      });
    }
    this.pending.clear();
  }
}
