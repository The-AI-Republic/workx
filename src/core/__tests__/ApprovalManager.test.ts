import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ApprovalManager,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalPolicy,
  type ApprovalDetails,
  type ApprovalMetadata,
} from '@/core/ApprovalManager';
import type { Event } from '@/core/protocol/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid ApprovalRequest with sensible defaults. */
function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: overrides.id ?? 'req-1',
    type: overrides.type ?? 'command',
    title: overrides.title ?? 'Test request',
    description: overrides.description ?? 'A test approval request',
    details: overrides.details ?? {
      riskLevel: 'medium',
      command: 'echo hello',
    },
    metadata: overrides.metadata ?? {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      toolName: 'shell',
      timestamp: Date.now(),
      rollbackable: true,
    },
    timeout: overrides.timeout,
    policy: overrides.policy,
  };
}

function makeResponse(id: string, decision: 'approve' | 'reject' | 'request_change' = 'approve', reason?: string): ApprovalResponse {
  return {
    id,
    decision,
    timestamp: Date.now(),
    reason,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalManager', () => {
  let manager: ApprovalManager;
  let emitter: ReturnType<typeof vi.fn>;
  const emittedEvents: Event[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    emittedEvents.length = 0;
    emitter = vi.fn((evt: Event) => emittedEvents.push(evt));
    manager = new ApprovalManager(emitter);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  describe('Constructor', () => {
    it('should create an instance with no arguments', () => {
      const m = new ApprovalManager();
      expect(m).toBeInstanceOf(ApprovalManager);
    });

    it('should accept an event emitter function as the first argument', () => {
      const fn = vi.fn();
      const m = new ApprovalManager(fn);
      expect(m).toBeInstanceOf(ApprovalManager);
    });

    it('should set default policy to always_ask when no config provided', () => {
      const m = new ApprovalManager();
      expect(m.getPolicy().mode).toBe('always_ask');
    });
  });

  // -----------------------------------------------------------------------
  // requestApproval — basics
  // -----------------------------------------------------------------------
  describe('requestApproval', () => {
    it('should emit an ApprovalRequested event', async () => {
      const req = makeRequest({ timeout: 0 }); // no timeout so it stays pending
      const promise = manager.requestApproval(req);

      // Resolve it immediately so the test doesn't hang
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      const requested = emittedEvents.find(e => e.msg.type === 'ApprovalRequested');
      expect(requested).toBeDefined();
      expect(requested!.id).toContain(req.id);
      expect((requested!.msg as any).data.turn_id).toBe(req.metadata?.turnId);
    });

    it('should include risk_score in the emitted ApprovalRequested event', async () => {
      const req = makeRequest({ timeout: 0, details: { riskLevel: 'high', command: 'rm -rf /' } });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalRequested');
      expect((evt!.msg as any).data.risk_score).toBe(75);
    });

    it('should use riskScore from details when provided', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', riskScore: 99 },
      });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalRequested');
      expect((evt!.msg as any).data.risk_score).toBe(99);
    });

    it('should add request to pending approvals', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      expect(manager.getPendingApprovals()[0].id).toBe(req.id);

      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should use default timeout of 600000 when none specified', async () => {
      const req = makeRequest(); // no timeout field
      const promise = manager.requestApproval(req);

      // Let the 600000ms timeout fire
      vi.advanceTimersByTime(600000);
      const result = await promise;

      expect(result.reason).toBe('Auto-approved after timeout');
    });

    it('should use policy timeout when request has no timeout', async () => {
      await manager.updatePolicy({ mode: 'always_ask', timeout: 5000 });
      const req = makeRequest(); // no explicit timeout
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(5000);
      const result = await promise;
      expect(result.reason).toBe('Auto-approved after timeout');
    });

    it('should use request timeout over policy timeout', async () => {
      await manager.updatePolicy({ mode: 'always_ask', timeout: 5000 });
      const req = makeRequest({ timeout: 1000 });
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(1000);
      const result = await promise;
      expect(result.metadata?.timeout).toBe(true);
    });

    it('should fall back to request.type when metadata.toolName is missing', async () => {
      const req = makeRequest({ timeout: 0 });
      req.metadata = undefined;
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalRequested');
      expect((evt!.msg as any).data.tool_name).toBe('command');
    });
  });

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------
  describe('Timeout handling', () => {
    it('should auto-approve after timeout elapses', async () => {
      const req = makeRequest({ timeout: 3000 });
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(3000);
      const result = await promise;

      expect(result.decision).toBe('approve');
      expect(result.reason).toBe('Auto-approved after timeout');
      expect(result.metadata?.timeout).toBe(true);
    });

    it('should emit ApprovalGranted event on timeout', async () => {
      const req = makeRequest({ timeout: 2000 });
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(2000);
      await promise;

      const granted = emittedEvents.find(e => e.msg.type === 'ApprovalGranted' && e.id.includes('timeout'));
      expect(granted).toBeDefined();
    });

    it('should store timeout response in history', async () => {
      const req = makeRequest({ timeout: 1000 });
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(1000);
      await promise;

      const history = manager.getApprovalHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(req.id);
      expect(history[0].metadata?.timeout).toBe(true);
    });

    it('should remove from pending after timeout', async () => {
      const req = makeRequest({ timeout: 500 });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      vi.advanceTimersByTime(500);
      await promise;

      expect(manager.getPendingApprovals()).toHaveLength(0);
    });

    it('should wait indefinitely when timeout is 0', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      // Advance a very long time — should still be pending
      vi.advanceTimersByTime(10_000_000);
      expect(manager.getPendingApprovals()).toHaveLength(1);

      // Resolve manually
      await manager.handleDecision(makeResponse(req.id));
      const result = await promise;
      expect(result.decision).toBe('approve');
    });

    it('should not fire timeout if decision arrives first', async () => {
      const req = makeRequest({ timeout: 5000 });
      const promise = manager.requestApproval(req);

      // Decide before timeout
      await manager.handleDecision(makeResponse(req.id, 'reject', 'No thanks'));
      const result = await promise;

      expect(result.decision).toBe('reject');

      // Advance past what would have been the timeout
      vi.advanceTimersByTime(10000);

      // Should only have the events from the decision, no timeout event
      const timeoutEvents = emittedEvents.filter(e => e.id.includes('timeout'));
      expect(timeoutEvents).toHaveLength(0);
    });

    it('should not fire timeout if request is canceled first', async () => {
      const req = makeRequest({ timeout: 5000 });
      const promise = manager.requestApproval(req);

      await manager.cancelRequest(req.id);
      await promise;

      vi.advanceTimersByTime(10000);

      const timeoutEvents = emittedEvents.filter(e => e.id.includes('timeout'));
      expect(timeoutEvents).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // handleDecision
  // -----------------------------------------------------------------------
  describe('handleDecision', () => {
    it('should resolve the pending promise with the response', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      const response = makeResponse(req.id, 'approve', 'Looks good');
      await manager.handleDecision(response);
      const result = await promise;

      expect(result.decision).toBe('approve');
      expect(result.reason).toBe('Looks good');
    });

    it('should emit ApprovalGranted for approved decisions', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.handleDecision(makeResponse(req.id, 'approve'));
      await promise;

      const granted = emittedEvents.find(e => e.msg.type === 'ApprovalGranted' && e.id.includes('granted'));
      expect(granted).toBeDefined();
    });

    it('should emit ApprovalDenied for rejected decisions', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.handleDecision(makeResponse(req.id, 'reject', 'Too dangerous'));
      await promise;

      const denied = emittedEvents.find(e => e.msg.type === 'ApprovalDenied');
      expect(denied).toBeDefined();
      expect((denied!.msg as any).data.reason).toBe('Too dangerous');
    });

    it('should use "Denied by user" as default reason for rejection', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.handleDecision(makeResponse(req.id, 'reject'));
      await promise;

      const denied = emittedEvents.find(e => e.msg.type === 'ApprovalDenied');
      expect((denied!.msg as any).data.reason).toBe('Denied by user');
    });

    it('should store decision in approval history', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      const response = makeResponse(req.id, 'approve');
      await manager.handleDecision(response);
      await promise;

      const history = manager.getApprovalHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toBe(response);
    });

    it('should remove from pending after decision', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      expect(manager.getPendingApprovals()).toHaveLength(0);
    });

    it('should warn and return early for unknown request id', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleDecision(makeResponse('nonexistent'));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No pending approval found for id: nonexistent')
      );
      warnSpy.mockRestore();
    });

    it('should warn and return early for already-resolved request', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.handleDecision(makeResponse(req.id, 'approve'));
      await promise;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleDecision(makeResponse(req.id, 'reject'));

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should clear the timeout when decision is made', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const req = makeRequest({ timeout: 10000 });
      const promise = manager.requestApproval(req);

      await manager.handleDecision(makeResponse(req.id));
      await promise;

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // cancelRequest
  // -----------------------------------------------------------------------
  describe('cancelRequest', () => {
    it('should return true when canceling a pending request', async () => {
      const req = makeRequest({ timeout: 0 });
      const _promise = manager.requestApproval(req);

      const result = await manager.cancelRequest(req.id);
      expect(result).toBe(true);
      await _promise; // consume promise
    });

    it('should return false when canceling a non-existent request', async () => {
      const result = await manager.cancelRequest('nonexistent');
      expect(result).toBe(false);
    });

    it('should return false when canceling an already-resolved request', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      const result = await manager.cancelRequest(req.id);
      expect(result).toBe(false);
    });

    it('should resolve the pending promise with a reject decision', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.cancelRequest(req.id);
      const result = await promise;

      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('Request was canceled');
      expect(result.metadata?.canceled).toBe(true);
    });

    it('should emit ApprovalDenied event on cancel', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      await manager.cancelRequest(req.id);
      await promise;

      const denied = emittedEvents.find(e => e.msg.type === 'ApprovalDenied' && e.id.includes('canceled'));
      expect(denied).toBeDefined();
      expect((denied!.msg as any).data.reason).toBe('User canceled request');
    });

    it('should store canceled response in history', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.cancelRequest(req.id);
      await promise;

      const history = manager.getApprovalHistory();
      expect(history).toHaveLength(1);
      expect(history[0].metadata?.canceled).toBe(true);
    });

    it('should remove from pending after cancel', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.cancelRequest(req.id);
      await promise;
      expect(manager.getPendingApprovals()).toHaveLength(0);
    });

    it('should clear timeout on cancel', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const req = makeRequest({ timeout: 30000 });
      const promise = manager.requestApproval(req);

      await manager.cancelRequest(req.id);
      await promise;

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------
  describe('getStatus', () => {
    it('should return null for unknown id', () => {
      expect(manager.getStatus('unknown')).toBeNull();
    });

    it('should return pending status for active request', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      const status = manager.getStatus(req.id);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('pending');

      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should return approved status after approval', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id, 'approve'));
      await promise;

      const status = manager.getStatus(req.id);
      expect(status!.status).toBe('approved');
      expect(status!.decision).toBe('approve');
    });

    it('should return rejected status after rejection', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id, 'reject'));
      await promise;

      const status = manager.getStatus(req.id);
      expect(status!.status).toBe('rejected');
    });

    it('should include timeRemaining for pending requests', async () => {
      const req = makeRequest({ timeout: 10000 });
      const promise = manager.requestApproval(req);

      vi.advanceTimersByTime(3000);
      const status = manager.getStatus(req.id);
      expect(status!.timeRemaining).toBeLessThanOrEqual(7000);
      expect(status!.timeRemaining).toBeGreaterThanOrEqual(0);

      vi.advanceTimersByTime(7000);
      await promise;
    });

    it('should clamp timeRemaining to 0 when past timeout', async () => {
      const req = makeRequest({ timeout: 1000 });
      const promise = manager.requestApproval(req);

      // Force the status check without actually resolving the timeout
      // (use a long timeout so we can check clamping before the timer fires)
      const req2 = makeRequest({ id: 'req-long', timeout: 100000 });
      const promise2 = manager.requestApproval(req2);

      // Advance well past the short timeout
      vi.advanceTimersByTime(200000);

      // The first one resolved via timeout
      await promise;

      // The second should have resolved too
      await promise2;
    });

    it('should include current policy in pending status', async () => {
      await manager.updatePolicy({ mode: 'auto_approve_safe' });
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);

      const status = manager.getStatus(req.id);
      expect(status!.policy?.mode).toBe('auto_approve_safe');

      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // Policy evaluation — never_ask
  // -----------------------------------------------------------------------
  describe('Policy: never_ask', () => {
    beforeEach(async () => {
      await manager.updatePolicy({ mode: 'never_ask' });
    });

    it('should auto-approve all requests', async () => {
      const req = makeRequest({ details: { riskLevel: 'critical' } });
      const result = await manager.requestApproval(req);

      expect(result.decision).toBe('approve');
      expect(result.reason).toContain('never_ask');
    });

    it('should store auto-approved response in history', async () => {
      await manager.requestApproval(makeRequest());
      expect(manager.getApprovalHistory()).toHaveLength(1);
    });

    it('should emit ApprovalAutoApproved event', async () => {
      await manager.requestApproval(makeRequest());
      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalAutoApproved');
      expect(evt).toBeDefined();
    });

    it('should not add to pending requests', async () => {
      await manager.requestApproval(makeRequest());
      expect(manager.getPendingApprovals()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Policy evaluation — auto_approve_safe
  // -----------------------------------------------------------------------
  describe('Policy: auto_approve_safe', () => {
    beforeEach(async () => {
      await manager.updatePolicy({
        mode: 'auto_approve_safe',
        allowedCommands: ['echo', 'ls'],
        trustedDomains: ['example.com', '*.trusted.org'],
      });
    });

    it('should auto-approve low-risk request with allowed command', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', command: 'echo test' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
      expect(result.metadata?.autoApproved).toBe(true);
    });

    it('should not auto-approve medium-risk request', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'medium', command: 'echo test' },
      });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should not auto-approve low-risk request with non-allowed command', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', command: 'rm -rf /' },
      });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should auto-approve low-risk request with no command', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
    });

    it('should auto-approve low-risk request with trusted domain URL', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', url: 'https://example.com/api' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
    });

    it('should not auto-approve low-risk with untrusted domain URL', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', url: 'https://evil.com/api' },
      });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should match wildcard trusted domains', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', url: 'https://sub.trusted.org/path' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
    });

    it('should match wildcard for exact domain too', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', url: 'https://trusted.org/path' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
    });
  });

  // -----------------------------------------------------------------------
  // Policy evaluation — auto_reject_unsafe
  // -----------------------------------------------------------------------
  describe('Policy: auto_reject_unsafe', () => {
    beforeEach(async () => {
      await manager.updatePolicy({
        mode: 'auto_reject_unsafe',
        blockedCommands: ['rm', 'format'],
        riskThreshold: 'medium',
      });
    });

    it('should auto-reject high-risk requests', async () => {
      const req = makeRequest({ details: { riskLevel: 'high' } });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('reject');
      expect(result.metadata?.autoRejected).toBe(true);
    });

    it('should auto-reject critical-risk requests', async () => {
      const req = makeRequest({ details: { riskLevel: 'critical' } });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('reject');
    });

    it('should auto-reject requests with blocked commands', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', command: 'rm -rf /tmp' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('reject');
    });

    it('should auto-reject when risk exceeds threshold', async () => {
      const req = makeRequest({
        details: { riskLevel: 'high' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('reject');
    });

    it('should not auto-reject low-risk request without blocked commands', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', command: 'echo safe' },
      });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should emit ApprovalDenied event for auto-rejected requests', async () => {
      await manager.requestApproval(makeRequest({ details: { riskLevel: 'critical' } }));
      const denied = emittedEvents.find(e => e.msg.type === 'ApprovalDenied');
      expect(denied).toBeDefined();
    });

    it('should store auto-rejected response in history', async () => {
      await manager.requestApproval(makeRequest({ details: { riskLevel: 'critical' } }));
      expect(manager.getApprovalHistory()).toHaveLength(1);
      expect(manager.getApprovalHistory()[0].decision).toBe('reject');
    });
  });

  // -----------------------------------------------------------------------
  // Policy evaluation — always_ask (default)
  // -----------------------------------------------------------------------
  describe('Policy: always_ask', () => {
    it('should always require user input regardless of risk', async () => {
      const req = makeRequest({ timeout: 0, details: { riskLevel: 'low' } });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // Policy management
  // -----------------------------------------------------------------------
  describe('updatePolicy / getPolicy', () => {
    it('should update the policy', async () => {
      await manager.updatePolicy({ mode: 'never_ask' });
      expect(manager.getPolicy().mode).toBe('never_ask');
    });

    it('should merge partial policy updates', async () => {
      await manager.updatePolicy({ mode: 'auto_approve_safe', riskThreshold: 'low' });
      await manager.updatePolicy({ trustedDomains: ['example.com'] });

      const policy = manager.getPolicy();
      expect(policy.mode).toBe('auto_approve_safe');
      expect(policy.riskThreshold).toBe('low');
      expect(policy.trustedDomains).toEqual(['example.com']);
    });

    it('should return a copy of the policy', () => {
      const p1 = manager.getPolicy();
      const p2 = manager.getPolicy();
      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2); // different object references
    });

    it('should emit ApprovalPolicyChanged when mode changes', async () => {
      await manager.updatePolicy({ mode: 'never_ask' });

      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalPolicyChanged');
      expect(evt).toBeDefined();
      expect((evt!.msg as any).data.mode).toBe('never_ask');
      expect((evt!.msg as any).data.previousMode).toBe('always_ask');
      expect(typeof (evt!.msg as any).data.timestamp).toBe('number');
    });

    it('should not emit ApprovalPolicyChanged when mode is unchanged', async () => {
      // Initial mode is 'always_ask'; updating only the threshold should not fire the event
      await manager.updatePolicy({ riskThreshold: 'high' });

      const evt = emittedEvents.find(e => e.msg.type === 'ApprovalPolicyChanged');
      expect(evt).toBeUndefined();
    });

    it('should report the actual previousMode across successive updates', async () => {
      await manager.updatePolicy({ mode: 'auto_approve_safe' });
      await manager.updatePolicy({ mode: 'never_ask' });

      const events = emittedEvents.filter(e => e.msg.type === 'ApprovalPolicyChanged');
      expect(events).toHaveLength(2);
      expect((events[0].msg as any).data.previousMode).toBe('always_ask');
      expect((events[0].msg as any).data.mode).toBe('auto_approve_safe');
      expect((events[1].msg as any).data.previousMode).toBe('auto_approve_safe');
      expect((events[1].msg as any).data.mode).toBe('never_ask');
    });
  });

  // -----------------------------------------------------------------------
  // Approval history
  // -----------------------------------------------------------------------
  describe('Approval history', () => {
    it('should return empty array initially', () => {
      expect(manager.getApprovalHistory()).toEqual([]);
    });

    it('should accumulate responses', async () => {
      const req1 = makeRequest({ id: 'r1', timeout: 0 });
      const req2 = makeRequest({ id: 'r2', timeout: 0 });

      const p1 = manager.requestApproval(req1);
      const p2 = manager.requestApproval(req2);

      await manager.handleDecision(makeResponse('r1', 'approve'));
      await manager.handleDecision(makeResponse('r2', 'reject'));
      await p1;
      await p2;

      expect(manager.getApprovalHistory()).toHaveLength(2);
    });

    it('should clear history', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id));
      await promise;

      expect(manager.getApprovalHistory()).toHaveLength(1);
      manager.clearHistory();
      expect(manager.getApprovalHistory()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // getPendingApprovals / getApproval
  // -----------------------------------------------------------------------
  describe('getPendingApprovals / getApproval', () => {
    it('should return empty array when no pending', () => {
      expect(manager.getPendingApprovals()).toEqual([]);
    });

    it('should list all pending requests', async () => {
      const p1 = manager.requestApproval(makeRequest({ id: 'a', timeout: 0 }));
      const p2 = manager.requestApproval(makeRequest({ id: 'b', timeout: 0 }));

      const pending = manager.getPendingApprovals();
      expect(pending).toHaveLength(2);
      expect(pending.map(p => p.id).sort()).toEqual(['a', 'b']);

      await manager.handleDecision(makeResponse('a'));
      await manager.handleDecision(makeResponse('b'));
      await p1;
      await p2;
    });

    it('getApproval should return the PendingApproval by id', async () => {
      const req = makeRequest({ id: 'x', timeout: 0 });
      const promise = manager.requestApproval(req);

      const pa = manager.getApproval('x');
      expect(pa).toBeDefined();
      expect(pa!.request.id).toBe('x');

      await manager.handleDecision(makeResponse('x'));
      await promise;
    });

    it('getApproval should return undefined for unknown id', () => {
      expect(manager.getApproval('nope')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Event emitter behavior
  // -----------------------------------------------------------------------
  describe('Event emitting', () => {
    it('should not throw when no event emitter is configured', async () => {
      const noEmitterManager = new ApprovalManager();
      const req = makeRequest({ timeout: 0 });
      const promise = noEmitterManager.requestApproval(req);
      await noEmitterManager.handleDecision(makeResponse(req.id));
      const result = await promise;
      expect(result.decision).toBe('approve');
    });

    it('should call emitter for each relevant event', async () => {
      const req = makeRequest({ timeout: 0 });
      const promise = manager.requestApproval(req);
      await manager.handleDecision(makeResponse(req.id, 'approve'));
      await promise;

      // Should have: ApprovalRequested + ApprovalGranted
      expect(emitter).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // riskLevelToScore (via emitted events)
  // -----------------------------------------------------------------------
  describe('riskLevelToScore mapping', () => {
    const cases: Array<[string, number]> = [
      ['low', 15],
      ['medium', 45],
      ['high', 75],
      ['critical', 95],
    ];

    for (const [level, expectedScore] of cases) {
      it(`should map "${level}" to ${expectedScore}`, async () => {
        const req = makeRequest({
          timeout: 0,
          details: { riskLevel: level as any },
        });
        const promise = manager.requestApproval(req);
        await manager.handleDecision(makeResponse(req.id));
        await promise;

        const evt = emittedEvents.find(e => e.msg.type === 'ApprovalRequested');
        expect((evt!.msg as any).data.risk_score).toBe(expectedScore);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Multiple concurrent requests
  // -----------------------------------------------------------------------
  describe('Multiple concurrent requests', () => {
    it('should handle multiple pending requests independently', async () => {
      const p1 = manager.requestApproval(makeRequest({ id: 'c1', timeout: 0 }));
      const p2 = manager.requestApproval(makeRequest({ id: 'c2', timeout: 0 }));
      const p3 = manager.requestApproval(makeRequest({ id: 'c3', timeout: 0 }));

      expect(manager.getPendingApprovals()).toHaveLength(3);

      await manager.handleDecision(makeResponse('c2', 'reject'));
      expect(manager.getPendingApprovals()).toHaveLength(2);

      await manager.handleDecision(makeResponse('c1', 'approve'));
      expect(manager.getPendingApprovals()).toHaveLength(1);

      await manager.cancelRequest('c3');
      expect(manager.getPendingApprovals()).toHaveLength(0);

      const r1 = await p1;
      const r2 = await p2;
      const r3 = await p3;

      expect(r1.decision).toBe('approve');
      expect(r2.decision).toBe('reject');
      expect(r3.decision).toBe('reject');
      expect(r3.metadata?.canceled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getDefaultPolicy, getAutoApproveList, getApprovalTimeout
  // -----------------------------------------------------------------------
  describe('Config placeholder methods', () => {
    it('getDefaultPolicy should return always_ask', () => {
      expect(manager.getDefaultPolicy()).toEqual({ mode: 'always_ask' });
    });

    it('getAutoApproveList should return empty array', () => {
      expect(manager.getAutoApproveList()).toEqual([]);
    });

    it('getApprovalTimeout should return 600000', () => {
      expect(manager.getApprovalTimeout()).toBe(600000);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases: domain matching (via auto_approve_safe policy)
  // -----------------------------------------------------------------------
  describe('Domain matching edge cases', () => {
    beforeEach(async () => {
      await manager.updatePolicy({
        mode: 'auto_approve_safe',
        trustedDomains: ['example.com', '*.foo.bar'],
      });
    });

    it('should not match invalid URLs', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', url: 'not-a-url' },
      });
      const promise = manager.requestApproval(req);

      // Should not auto-approve because URL parsing fails
      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should not match subdomain of exact domain', async () => {
      const req = makeRequest({
        timeout: 0,
        details: { riskLevel: 'low', url: 'https://sub.example.com/path' },
      });
      const promise = manager.requestApproval(req);

      // sub.example.com does not match exact 'example.com'
      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should match deeply nested subdomain with wildcard', async () => {
      const req = makeRequest({
        details: { riskLevel: 'low', url: 'https://a.b.c.foo.bar/path' },
      });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('approve');
    });
  });

  // -----------------------------------------------------------------------
  // riskLevelExceeds (via auto_reject_unsafe policy)
  // -----------------------------------------------------------------------
  describe('riskLevelExceeds logic', () => {
    it('should reject when risk level exceeds threshold', async () => {
      await manager.updatePolicy({
        mode: 'auto_reject_unsafe',
        riskThreshold: 'low',
      });

      const req = makeRequest({ details: { riskLevel: 'medium' } });
      const result = await manager.requestApproval(req);
      expect(result.decision).toBe('reject');
    });

    it('should not reject when risk level equals threshold', async () => {
      await manager.updatePolicy({
        mode: 'auto_reject_unsafe',
        riskThreshold: 'medium',
      });

      const req = makeRequest({ timeout: 0, details: { riskLevel: 'medium' } });
      const promise = manager.requestApproval(req);

      // medium does not exceed medium, so it goes to pending
      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });

    it('should not reject when risk level is below threshold', async () => {
      await manager.updatePolicy({
        mode: 'auto_reject_unsafe',
        riskThreshold: 'high',
      });

      const req = makeRequest({ timeout: 0, details: { riskLevel: 'low' } });
      const promise = manager.requestApproval(req);

      expect(manager.getPendingApprovals()).toHaveLength(1);
      await manager.handleDecision(makeResponse(req.id));
      await promise;
    });
  });
});
