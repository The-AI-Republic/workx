/**
 * ApprovalManager - Handles approval requests with policies and timeout handling
 * Based on contract from approval-manager.test.ts
 */

import type { ReviewDecision } from './protocol/types';
import type { Event } from './protocol/types';
import type { AgentConfig } from '../config/AgentConfig';

export interface ApprovalRequest {
  id: string;
  type: 'command' | 'file_operation' | 'network_access' | 'storage_access' | 'dangerous_action';
  title: string;
  description: string;
  details: ApprovalDetails;
  metadata?: ApprovalMetadata;
  timeout?: number;
  policy?: ApprovalPolicy;
}

export interface ApprovalDetails {
  command?: string;
  filePath?: string;
  url?: string;
  action?: string;
  parameters?: Record<string, any>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskScore?: number;
  impact?: string[];
}

export interface ApprovalMetadata {
  sessionId: string;
  turnId: string;
  toolName: string;
  timestamp: number;
  userId?: string;
  rollbackable: boolean;
  description?: string;
  tags?: string[];
  /** Current page domain (for web tools memory key) */
  domain?: string;
  /** Final risk score after enhancers (for risk ceiling guard) */
  riskScore?: number;
}

export interface ApprovalResponse {
  id: string;
  decision: ReviewDecision;
  timestamp: number;
  reason?: string;
  modifications?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ApprovalPolicy {
  mode: 'always_ask' | 'auto_approve_safe' | 'auto_reject_unsafe' | 'never_ask';
  riskThreshold?: 'low' | 'medium' | 'high';
  trustedDomains?: string[];
  allowedCommands?: string[];
  blockedCommands?: string[];
  timeout?: number;
}

export interface ApprovalStatus {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'timeout' | 'canceled';
  decision?: ReviewDecision;
  timestamp: number;
  timeRemaining?: number;
  policy?: ApprovalPolicy;
}

/**
 * ApprovalManager implementation
 */
export class ApprovalManager {
  private config?: AgentConfig;
  private policy: ApprovalPolicy = { mode: 'always_ask' };
  private pendingRequests = new Map<string, PendingApproval>();
  private approvalHistory = new Map<string, ApprovalResponse>();
  private eventEmitter?: (event: Event) => void;

  constructor(configOrEventEmitter?: AgentConfig | ((event: Event) => void), eventEmitter?: (event: Event) => void) {
    // Handle both signatures for backward compatibility
    if (configOrEventEmitter && typeof configOrEventEmitter !== 'function') {
      // New signature: ApprovalManager(config?: AgentConfig, eventEmitter?: (event: Event) => void)
      this.config = configOrEventEmitter as AgentConfig;
      this.eventEmitter = eventEmitter;
      // Setup policy from config
      this.policy = this.getDefaultPolicy();
    } else {
      // Old signature: ApprovalManager(eventEmitter?: (event: Event) => void)
      this.eventEmitter = configOrEventEmitter as (event: Event) => void;
    }
  }

  /**
   * Request approval for an action
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    // Apply policy to determine if we should auto-approve/reject
    const policyDecision = this.evaluatePolicy(request);
    if (policyDecision) {
      return policyDecision;
    }

    // Set up timeout handling
    // timeout=0 means no timeout (wait indefinitely for user input, used in balanced mode)
    const timeout = request.timeout !== undefined ? request.timeout : (this.policy.timeout || 600000);

    // Emit approval requested event
    this.emitEvent({
      id: `evt_approval_requested_${request.id}`,
      msg: {
        type: 'ApprovalRequested',
        data: {
          id: request.id,
          tool_name: request.metadata?.toolName || request.type,
          risk_score: request.details.riskScore ?? this.riskLevelToScore(request.details.riskLevel),
          risk_level: request.details.riskLevel || 'medium',
          risk_factors: request.details.impact || [],
          explanation: request.description || request.title,
          command: request.details.command,
          timeout,
        },
      },
    });

    // Create pending approval entry first so timeout can reference it
    const pendingApproval: PendingApproval = {
      request,
      timestamp: Date.now(),
      timeRemaining: timeout,
      resolved: false,
    };

    this.pendingRequests.set(request.id, pendingApproval);

    // Wait for user decision
    const userDecisionPromise = new Promise<ApprovalResponse>((resolve) => {
      pendingApproval.resolver = resolve;
    });

    // If timeout > 0, race user decision against auto-approve timer
    if (timeout > 0) {
      const timeoutPromise = new Promise<ApprovalResponse>((resolve) => {
        pendingApproval.timeoutId = setTimeout(() => {
          // Only fire if still pending (not already resolved by handleDecision/cancelRequest)
          if (pendingApproval.resolved || !this.pendingRequests.has(request.id)) return;
          pendingApproval.resolved = true;
          this.pendingRequests.delete(request.id);

          this.emitEvent({
            id: `evt_approval_timeout_${request.id}`,
            msg: {
              type: 'ApprovalGranted',
              data: {
                id: request.id,
                tool_name: request.metadata?.toolName || request.type,
                reason: 'Auto-approved after timeout',
                timestamp: Date.now(),
              },
            },
          });

          const timeoutResponse: ApprovalResponse = {
            id: request.id,
            decision: 'approve',
            timestamp: Date.now(),
            reason: 'Auto-approved after timeout',
            metadata: { timeout: true },
          };

          this.approvalHistory.set(request.id, timeoutResponse);
          resolve(timeoutResponse);
        }, timeout);
      });

      return Promise.race([userDecisionPromise, timeoutPromise]);
    }

    // No timeout — wait indefinitely for user input (balanced mode)
    return userDecisionPromise;
  }

  /**
   * Handle approval decision from user
   */
  async handleDecision(response: ApprovalResponse): Promise<void> {
    const pending = this.pendingRequests.get(response.id);
    if (!pending || pending.resolved) {
      console.warn(`[ApprovalManager] No pending approval found for id: ${response.id} (already processed or timed out)`);
      return;
    }

    // Mark as resolved to prevent timeout from also resolving
    pending.resolved = true;

    // Clear timeout to prevent duplicate events
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    // Remove from pending
    this.pendingRequests.delete(response.id);

    // Store in history
    this.approvalHistory.set(response.id, response);

    // Emit appropriate event
    if (response.decision === 'approve') {
      this.emitEvent({
        id: `evt_approval_granted_${response.id}`,
        msg: {
          type: 'ApprovalGranted',
          data: {
            id: response.id,
            tool_name: pending.request.metadata?.toolName || pending.request.type,
            timestamp: Date.now(),
          },
        },
      });
    } else {
      this.emitEvent({
        id: `evt_approval_denied_${response.id}`,
        msg: {
          type: 'ApprovalDenied',
          data: {
            id: response.id,
            tool_name: pending.request.metadata?.toolName || pending.request.type,
            reason: response.reason || 'Denied by user',
            timestamp: Date.now(),
          },
        },
      });
    }

    // Resolve the pending promise
    if (pending.resolver) {
      pending.resolver(response);
    }
  }

  /**
   * Get approval status
   */
  getStatus(id: string): ApprovalStatus | null {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      const elapsed = Date.now() - pending.timestamp;
      return {
        id,
        status: 'pending',
        timestamp: pending.timestamp,
        timeRemaining: Math.max(0, pending.timeRemaining - elapsed),
        policy: this.policy,
      };
    }

    const history = this.approvalHistory.get(id);
    if (history) {
      return {
        id,
        status: history.decision === 'approve' ? 'approved' : 'rejected',
        decision: history.decision,
        timestamp: history.timestamp,
      };
    }

    return null;
  }

  /**
   * Cancel pending approval request
   */
  async cancelRequest(id: string): Promise<boolean> {
    const pending = this.pendingRequests.get(id);
    if (!pending || pending.resolved) {
      return false;
    }

    // Mark as resolved to prevent timeout from also resolving
    pending.resolved = true;

    // Clear timeout to prevent duplicate events
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingRequests.delete(id);

    this.emitEvent({
      id: `evt_approval_canceled_${id}`,
      msg: {
        type: 'ApprovalDenied',
        data: {
          id,
          tool_name: pending.request.metadata?.toolName || pending.request.type,
          reason: 'User canceled request',
          timestamp: Date.now(),
        },
      },
    });

    // Resolve with canceled response
    if (pending.resolver) {
      const canceledResponse: ApprovalResponse = {
        id,
        decision: 'reject',
        timestamp: Date.now(),
        reason: 'Request was canceled',
        metadata: { canceled: true },
      };

      this.approvalHistory.set(id, canceledResponse);
      pending.resolver(canceledResponse);
    }

    return true;
  }

  /**
   * Update approval policy
   */
  async updatePolicy(updates: Partial<ApprovalPolicy>): Promise<void> {
    this.policy = { ...this.policy, ...updates };
  }

  /**
   * Get current policy
   */
  getPolicy(): ApprovalPolicy {
    return { ...this.policy };
  }

  /**
   * Get approval history
   */
  getApprovalHistory(): ApprovalResponse[] {
    return Array.from(this.approvalHistory.values());
  }

  /**
   * Clear approval history
   */
  clearHistory(): void {
    this.approvalHistory.clear();
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values()).map(p => p.request);
  }

  /**
   * Get a specific approval request by ID
   */
  getApproval(approvalId: string): PendingApproval | undefined {
    return this.pendingRequests.get(approvalId);
  }

  /**
   * Evaluate policy for automatic decisions
   */
  private evaluatePolicy(request: ApprovalRequest): ApprovalResponse | null {
    const { mode, riskThreshold, allowedCommands, blockedCommands, trustedDomains } = this.policy;

    // Never ask mode - auto approve everything (dangerous!)
    if (mode === 'never_ask') {
      return this.createAutoResponse(request, 'approve', 'Auto-approved by never_ask policy');
    }

    // Auto approve safe actions
    if (mode === 'auto_approve_safe') {
      const isLowRisk = request.details.riskLevel === 'low';
      const isAllowedCommand = !request.details.command ||
        (allowedCommands && allowedCommands.some(cmd =>
          request.details.command!.startsWith(cmd)
        ));
      const isTrustedDomain = !request.details.url ||
        (trustedDomains && trustedDomains.some(domain =>
          this.matchesDomain(request.details.url!, domain)
        ));

      if (isLowRisk && isAllowedCommand && isTrustedDomain) {
        return this.createAutoResponse(request, 'approve', 'Auto-approved by policy', { autoApproved: true });
      }
    }

    // Auto reject unsafe actions
    if (mode === 'auto_reject_unsafe') {
      const isHighRisk = request.details.riskLevel === 'high' || request.details.riskLevel === 'critical';
      const isBlockedCommand = request.details.command &&
        blockedCommands &&
        blockedCommands.some(cmd => request.details.command!.includes(cmd));
      const exceedsThreshold = riskThreshold &&
        this.riskLevelExceeds(request.details.riskLevel, riskThreshold);

      if (isHighRisk || isBlockedCommand || exceedsThreshold) {
        return this.createAutoResponse(request, 'reject', 'Auto-rejected by policy', { autoRejected: true });
      }
    }

    return null; // No automatic decision, require user input
  }

  /**
   * Create automatic approval response
   */
  private createAutoResponse(
    request: ApprovalRequest,
    decision: ReviewDecision,
    reason: string,
    metadata?: Record<string, any>
  ): ApprovalResponse {
    const response: ApprovalResponse = {
      id: request.id,
      decision,
      timestamp: Date.now(),
      reason,
      metadata,
    };

    // Store in history
    this.approvalHistory.set(request.id, response);

    // Emit event
    if (decision === 'approve') {
      this.emitEvent({
        id: `evt_auto_approved_${request.id}`,
        msg: {
          type: 'ApprovalAutoApproved',
          data: {
            tool_name: request.metadata?.toolName || request.type,
            risk_score: this.riskLevelToScore(request.details.riskLevel),
            risk_level: request.details.riskLevel,
          },
        },
      });
    } else {
      this.emitEvent({
        id: `evt_auto_rejected_${request.id}`,
        msg: {
          type: 'ApprovalDenied',
          data: {
            id: request.id,
            tool_name: request.metadata?.toolName || request.type,
            reason,
            timestamp: Date.now(),
          },
        },
      });
    }

    return response;
  }

  /**
   * Check if URL matches domain pattern
   */
  private matchesDomain(url: string, pattern: string): boolean {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        return hostname === domain || hostname.endsWith('.' + domain);
      }

      return hostname === pattern;
    } catch {
      return false;
    }
  }

  /**
   * Map risk level string to numeric score for event payloads
   */
  private riskLevelToScore(level: string): number {
    switch (level) {
      case 'low': return 15;
      case 'medium': return 45;
      case 'high': return 75;
      case 'critical': return 95;
      default: return 50;
    }
  }

  /**
   * Check if risk level exceeds threshold
   */
  private riskLevelExceeds(level: string, threshold: string): boolean {
    const levels = ['low', 'medium', 'high', 'critical'];
    const levelIndex = levels.indexOf(level);
    const thresholdIndex = levels.indexOf(threshold);
    return levelIndex > thresholdIndex;
  }

  /**
   * Emit event if emitter is available
   */
  private emitEvent(event: Event): void {
    if (this.eventEmitter) {
      this.eventEmitter(event);
    }
  }

  /**
   * Get default policy from config or fallback
   */
  getDefaultPolicy(): ApprovalPolicy {
    // Config integration placeholder - returns default
    return { mode: 'always_ask' };
  }

  /**
   * Get auto approve list from config
   */
  getAutoApproveList(): string[] {
    // Config integration placeholder - returns default
    return [];
  }

  /**
   * Get approval timeout from config
   */
  getApprovalTimeout(): number {
    // Config integration placeholder - returns default
    return 600000;
  }
}

/**
 * Internal pending approval tracking
 */
interface PendingApproval {
  request: ApprovalRequest;
  timestamp: number;
  timeRemaining: number;
  resolved: boolean;
  resolver?: (response: ApprovalResponse) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}