/**
 * Unit tests for ApprovalGate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalGate } from '../ApprovalGate';
import { PolicyRulesEngine } from '../PolicyRulesEngine';
import type { IRiskAssessor, IContextEnhancer, RiskAssessment, ApprovalContext, PolicyRule } from '../types';
import { RiskLevel, scoreToRiskLevel } from '../types';

// Mock ApprovalManager
function createMockApprovalManager(decision: 'approve' | 'reject' = 'approve') {
  return {
    requestApproval: vi.fn().mockResolvedValue({
      id: 'test',
      decision,
      timestamp: Date.now(),
    }),
    handleDecision: vi.fn(),
    getStatus: vi.fn(),
    cancelRequest: vi.fn(),
    updatePolicy: vi.fn(),
    getPolicy: vi.fn().mockReturnValue({ mode: 'always_ask' }),
    getDefaultPolicy: vi.fn().mockReturnValue({ mode: 'always_ask' }),
    getAutoApproveList: vi.fn().mockReturnValue([]),
    getApprovalTimeout: vi.fn().mockReturnValue(30000),
    getApproval: vi.fn(),
    getPendingApprovals: vi.fn().mockReturnValue([]),
    getApprovalHistory: vi.fn().mockReturnValue([]),
    clearHistory: vi.fn(),
  };
}

// Helper assessor
function createAssessor(score: number): IRiskAssessor {
  return {
    assess: (_toolName: string, _params: Record<string, any>) => ({
      score,
      level: scoreToRiskLevel(score),
      factors: [`Test score ${score}`],
      action: score <= 30 ? 'auto_approve' as const : score <= 85 ? 'ask_user' as const : 'deny' as const,
    }),
  };
}

describe('ApprovalGate', () => {
  let gate: ApprovalGate;
  let mockManager: ReturnType<typeof createMockApprovalManager>;
  let policyEngine: PolicyRulesEngine;

  beforeEach(() => {
    mockManager = createMockApprovalManager();
    const rules: PolicyRule[] = [
      { type: 'deny', match: { riskAbove: 85 }, description: 'Deny critical' },
      { type: 'ask', match: { riskAbove: 30 }, description: 'Ask medium+' },
      { type: 'allow', match: { tool: 'planning_tool' }, description: 'Allow planning' },
    ];
    policyEngine = new PolicyRulesEngine(rules);
    gate = new ApprovalGate(mockManager as any, policyEngine);
  });

  describe('auto_approve path', () => {
    it('should auto-approve low-risk tools', async () => {
      const assessor = createAssessor(5);
      const decision = await gate.check('planning_tool', {}, assessor);

      expect(decision).toBe('auto_approve');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });

    it('should auto-approve tools matching allow rules regardless of assessor', async () => {
      const assessor = createAssessor(10);
      const decision = await gate.check('planning_tool', {}, assessor);

      expect(decision).toBe('auto_approve');
    });
  });

  describe('deny path', () => {
    it('should deny critical-risk tools', async () => {
      const assessor = createAssessor(90);
      const decision = await gate.check('terminal', { command: 'rm -rf /' }, assessor);

      expect(decision).toBe('deny');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('ask_user path', () => {
    it('should ask user for medium-risk tools and approve on user acceptance', async () => {
      const assessor = createAssessor(50);
      const decision = await gate.check('dom_tool', { action: 'click' }, assessor);

      // ApprovalManager.requestApproval was called
      expect(mockManager.requestApproval).toHaveBeenCalled();
      // User approved → returns auto_approve
      expect(decision).toBe('auto_approve');
    });

    it('should deny when user rejects the approval request', async () => {
      mockManager = createMockApprovalManager('reject');
      gate = new ApprovalGate(mockManager as any, policyEngine);

      const assessor = createAssessor(50);
      const decision = await gate.check('dom_tool', { action: 'type' }, assessor);

      expect(mockManager.requestApproval).toHaveBeenCalled();
      expect(decision).toBe('deny');
    });
  });

  describe('default assessor fallback', () => {
    it('should use default score 20 when no assessor provided', async () => {
      // Score 20 is low → auto-approve (no rules match for score 20)
      const decision = await gate.check('unknown_tool', {});

      expect(decision).toBe('auto_approve');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('context enhancers', () => {
    it('should run enhancers and modify assessment', async () => {
      const enhancer: IContextEnhancer = {
        enhance: (assessment: RiskAssessment, _context: ApprovalContext): RiskAssessment => ({
          ...assessment,
          score: assessment.score + 30, // Boost score above ask threshold
          factors: [...assessment.factors, 'Enhanced by test'],
        }),
      };

      gate.addEnhancer(enhancer);

      // Base score 10 (auto-approve) + 30 enhancement = 40 (ask_user)
      const assessor = createAssessor(10);
      const decision = await gate.check('some_tool', {}, assessor);

      expect(mockManager.requestApproval).toHaveBeenCalled();
      expect(decision).toBe('auto_approve'); // User approved
    });
  });

  describe('session memory', () => {
    it('should remember decisions', async () => {
      const assessor = createAssessor(50);

      // First call: goes through full pipeline
      const decision1 = await gate.check('dom_tool', { action: 'click' }, assessor);
      expect(mockManager.requestApproval).toHaveBeenCalledTimes(1);

      // Remember this decision
      gate.rememberDecision('dom_tool', { action: 'click' }, 'auto_approve');

      // Second call: uses memory, skips pipeline
      mockManager.requestApproval.mockClear();
      const decision2 = await gate.check('dom_tool', { action: 'click' }, assessor);
      expect(decision2).toBe('auto_approve');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });

    it('should clear memory', async () => {
      gate.rememberDecision('dom_tool', { action: 'click' }, 'auto_approve');
      gate.clearMemory();

      const assessor = createAssessor(50);
      await gate.check('dom_tool', { action: 'click' }, assessor);

      // Should go through full pipeline again
      expect(mockManager.requestApproval).toHaveBeenCalled();
    });
  });

  describe('context passing', () => {
    it('should pass context to assessor and enhancers', async () => {
      const assessSpy = vi.fn().mockReturnValue({
        score: 10,
        level: RiskLevel.None,
        factors: ['test'],
        action: 'auto_approve',
      });
      const assessor: IRiskAssessor = { assess: assessSpy };

      const enhanceSpy = vi.fn().mockImplementation((assessment: RiskAssessment) => assessment);
      const enhancer: IContextEnhancer = { enhance: enhanceSpy };
      gate.addEnhancer(enhancer);

      await gate.check('dom_tool', { action: 'snapshot' }, assessor, {
        currentUrl: 'https://paypal.com',
        currentDomain: 'paypal.com',
        sessionId: 'session_1',
      });

      // Verify context was passed to assessor
      expect(assessSpy).toHaveBeenCalledWith(
        'dom_tool',
        { action: 'snapshot' },
        expect.objectContaining({
          toolName: 'dom_tool',
          currentDomain: 'paypal.com',
        })
      );

      // Verify context was passed to enhancer
      expect(enhanceSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          toolName: 'dom_tool',
          currentDomain: 'paypal.com',
        })
      );
    });
  });
});
