/**
 * Integration tests for ToolRegistry with ApprovalGate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../tools/ToolRegistry';
import { ApprovalGate } from '../ApprovalGate';
import { PolicyRulesEngine } from '../PolicyRulesEngine';
import { StaticRiskAssessor } from '../assessors/StaticRiskAssessor';
import type { ToolDefinition, ToolHandler } from '../../../tools/BaseTool';
import type { PolicyRule, IRiskAssessor } from '../types';
import { scoreToRiskLevel } from '../types';

// Helper to create a simple function tool definition
function createToolDef(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `Test tool ${name}`,
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input parameter' },
        },
      },
    },
  };
}

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
    onApprovalRequest: vi.fn(),
    getApproval: vi.fn(),
    getPendingApprovals: vi.fn().mockReturnValue([]),
    getApprovalHistory: vi.fn().mockReturnValue([]),
    clearHistory: vi.fn(),
  };
}

describe('ToolRegistry with ApprovalGate', () => {
  let registry: ToolRegistry;
  let mockManager: ReturnType<typeof createMockApprovalManager>;
  let handler: ToolHandler;

  beforeEach(() => {
    registry = new ToolRegistry();
    mockManager = createMockApprovalManager();
    handler = vi.fn().mockResolvedValue('tool result');
  });

  function wireApprovalGate(rules: PolicyRule[], decision: 'approve' | 'reject' = 'approve') {
    mockManager = createMockApprovalManager(decision);
    const engine = new PolicyRulesEngine(rules);
    const gate = new ApprovalGate(mockManager as any, engine);
    registry.setApprovalGate(gate);
  }

  it('should auto-approve a safe tool without contacting ApprovalManager', async () => {
    wireApprovalGate([
      { type: 'allow', match: { tool: 'safe_tool' }, description: 'Allow safe tool' },
    ]);

    const safeAssessor = new StaticRiskAssessor(0);
    await registry.register(createToolDef('safe_tool'), handler, safeAssessor);

    const result = await registry.execute({
      toolName: 'safe_tool',
      parameters: { input: 'hello' },
      sessionId: 'session_1',
      turnId: 'turn_1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('tool result');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('should deny a critical-risk tool without executing the handler', async () => {
    wireApprovalGate([
      { type: 'deny', match: { riskAbove: 85 }, description: 'Deny critical' },
    ]);

    // Create a high-risk assessor
    const criticalAssessor: IRiskAssessor = {
      assess: () => ({
        score: 95,
        level: scoreToRiskLevel(95),
        factors: ['Critical risk'],
        action: 'deny',
      }),
    };

    await registry.register(createToolDef('dangerous_tool'), handler, criticalAssessor);

    const result = await registry.execute({
      toolName: 'dangerous_tool',
      parameters: { input: 'danger' },
      sessionId: 'session_1',
      turnId: 'turn_1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('APPROVAL_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('should ask user for medium-risk tool and proceed on approval', async () => {
    wireApprovalGate([
      { type: 'ask', match: { riskAbove: 30 }, description: 'Ask medium+' },
    ], 'approve');

    const mediumAssessor: IRiskAssessor = {
      assess: () => ({
        score: 50,
        level: scoreToRiskLevel(50),
        factors: ['Medium risk'],
        action: 'ask_user',
      }),
    };

    await registry.register(createToolDef('medium_tool'), handler, mediumAssessor);

    const result = await registry.execute({
      toolName: 'medium_tool',
      parameters: { input: 'test' },
      sessionId: 'session_1',
      turnId: 'turn_1',
    });

    expect(result.success).toBe(true);
    expect(mockManager.requestApproval).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('should deny medium-risk tool when user rejects', async () => {
    wireApprovalGate([
      { type: 'ask', match: { riskAbove: 30 }, description: 'Ask medium+' },
    ], 'reject');

    const mediumAssessor: IRiskAssessor = {
      assess: () => ({
        score: 50,
        level: scoreToRiskLevel(50),
        factors: ['Medium risk'],
        action: 'ask_user',
      }),
    };

    await registry.register(createToolDef('medium_tool'), handler, mediumAssessor);

    const result = await registry.execute({
      toolName: 'medium_tool',
      parameters: { input: 'test' },
      sessionId: 'session_1',
      turnId: 'turn_1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('APPROVAL_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('should work normally without an approval gate', async () => {
    // No gate set
    await registry.register(createToolDef('any_tool'), handler);

    const result = await registry.execute({
      toolName: 'any_tool',
      parameters: { input: 'hello' },
      sessionId: 'session_1',
      turnId: 'turn_1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('tool result');
  });

  it('should pass metadata context to approval gate', async () => {
    wireApprovalGate([
      { type: 'ask', match: { riskAbove: 30 }, description: 'Ask medium+' },
    ]);

    const mediumAssessor: IRiskAssessor = {
      assess: () => ({
        score: 50,
        level: scoreToRiskLevel(50),
        factors: ['Medium risk'],
        action: 'ask_user',
      }),
    };

    await registry.register(createToolDef('dom_tool'), handler, mediumAssessor);

    await registry.execute({
      toolName: 'dom_tool',
      parameters: { action: 'click' },
      sessionId: 'session_1',
      turnId: 'turn_1',
      metadata: {
        currentUrl: 'https://example.com/page',
        currentDomain: 'example.com',
      },
    });

    // Verify approval request includes tool context
    const approvalCall = mockManager.requestApproval.mock.calls[0][0];
    expect(approvalCall.metadata.toolName).toBe('dom_tool');
  });
});
