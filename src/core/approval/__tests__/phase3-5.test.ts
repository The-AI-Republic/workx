/**
 * Tests for Phases 3-5:
 * - ApprovalConfigStorage (load/save/history)
 * - ApprovalMode (threshold changes per mode)
 * - Trusted/blocked domains (fast-path behavior)
 * - History tracking (entries recorded)
 * - ApprovalGate mode integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalConfigStorage } from '../ApprovalConfigStorage';
import { ApprovalGate } from '../ApprovalGate';
import { PolicyRulesEngine } from '../PolicyRulesEngine';
import { RiskLevel, scoreToRiskLevel, DEFAULT_APPROVAL_CONFIG } from '../types';
import type { RiskAssessment, ApprovalContext, IRiskAssessor, ApprovalHistoryEntry, IApprovalConfig } from '../types';

// ============================================================================
// Mock Storage
// ============================================================================

function createMockStorage() {
  const store: Record<string, any> = {};
  return {
    get: vi.fn(async (keys: string[]) => {
      const result: Record<string, any> = {};
      for (const key of keys) {
        if (store[key] !== undefined) result[key] = store[key];
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, any>) => {
      Object.assign(store, items);
    }),
    _store: store,
  };
}

function createMockApprovalManager() {
  return {
    requestApproval: vi.fn(async () => ({ decision: 'approve' as const, id: 'test' })),
    getApproval: vi.fn(),
    cancelRequest: vi.fn(),
    updatePolicy: vi.fn(),
    getPolicy: vi.fn(),
    getApprovalHistory: vi.fn(),
  } as any;
}

function makeAssessor(score: number): IRiskAssessor {
  return {
    assess: () => ({
      score,
      level: scoreToRiskLevel(score),
      factors: [`Score: ${score}`],
      action: score <= 30 ? 'auto_approve' as const : score <= 85 ? 'ask_user' as const : 'deny' as const,
    }),
  };
}

// ============================================================================
// ApprovalConfigStorage
// ============================================================================

describe('ApprovalConfigStorage', () => {
  let mockStorage: ReturnType<typeof createMockStorage>;
  let configStorage: ApprovalConfigStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    configStorage = new ApprovalConfigStorage(() => mockStorage);
  });

  describe('loadConfig', () => {
    it('should return defaults when storage is empty', async () => {
      const config = await configStorage.loadConfig();
      expect(config).toEqual(DEFAULT_APPROVAL_CONFIG);
    });

    it('should merge stored config with defaults', async () => {
      mockStorage._store['approval_config'] = { mode: 'high_speed' };
      const config = await configStorage.loadConfig();
      expect(config.mode).toBe('high_speed');
      expect(config.version).toBe('1.0.0'); // from defaults
      expect(config.timeouts).toEqual(DEFAULT_APPROVAL_CONFIG.timeouts);
    });

    it('should preserve stored timeout overrides', async () => {
      mockStorage._store['approval_config'] = {
        mode: 'balanced',
        timeouts: { low: 10000, medium: 20000 },
      };
      const config = await configStorage.loadConfig();
      expect(config.timeouts.low).toBe(10000);
      expect(config.timeouts.medium).toBe(20000);
      expect(config.timeouts.high).toBe(120000); // default
    });
  });

  describe('saveConfig', () => {
    it('should save config to storage', async () => {
      const config: IApprovalConfig = {
        ...DEFAULT_APPROVAL_CONFIG,
        mode: 'high_speed',
      };
      await configStorage.saveConfig(config);
      expect(mockStorage.set).toHaveBeenCalledWith({
        approval_config: config,
      });
    });
  });

  describe('loadHistory', () => {
    it('should return empty array when no history', async () => {
      const history = await configStorage.loadHistory();
      expect(history).toEqual([]);
    });

    it('should return stored history', async () => {
      const entries: ApprovalHistoryEntry[] = [
        {
          timestamp: 1000,
          toolName: 'terminal',
          riskScore: 65,
          riskLevel: RiskLevel.High,
          decision: 'ask_user',
          source: 'user',
          factors: ['Dangerous command'],
        },
      ];
      mockStorage._store['approval_history'] = entries;
      const history = await configStorage.loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].toolName).toBe('terminal');
    });

    it('should respect limit parameter', async () => {
      const entries: ApprovalHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
        timestamp: i,
        toolName: 'tool',
        riskScore: 0,
        riskLevel: RiskLevel.None,
        decision: 'auto_approve' as const,
        source: 'auto' as const,
        factors: [],
      }));
      mockStorage._store['approval_history'] = entries;
      const history = await configStorage.loadHistory(3);
      expect(history).toHaveLength(3);
    });
  });

  describe('appendHistory', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should append entry to history after debounce flush', async () => {
      const entry: ApprovalHistoryEntry = {
        timestamp: Date.now(),
        toolName: 'terminal',
        riskScore: 50,
        riskLevel: RiskLevel.Medium,
        decision: 'ask_user',
        source: 'user',
        factors: ['Modifying command'],
      };
      await configStorage.appendHistory(entry);

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockStorage.set).toHaveBeenCalled();
      const savedHistory = mockStorage._store['approval_history'];
      expect(savedHistory).toHaveLength(1);
      expect(savedHistory[0].toolName).toBe('terminal');
    });

    it('should cap history at 100 entries', async () => {
      // Pre-fill with 100 entries
      mockStorage._store['approval_history'] = Array.from({ length: 100 }, (_, i) => ({
        timestamp: i,
        toolName: 'tool',
        riskScore: 0,
        riskLevel: RiskLevel.None,
        decision: 'auto_approve' as const,
        source: 'auto' as const,
        factors: [],
      }));

      const entry: ApprovalHistoryEntry = {
        timestamp: 200,
        toolName: 'new_tool',
        riskScore: 50,
        riskLevel: RiskLevel.Medium,
        decision: 'ask_user',
        source: 'user',
        factors: [],
      };
      await configStorage.appendHistory(entry);

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(3000);

      const savedHistory = mockStorage._store['approval_history'];
      expect(savedHistory).toHaveLength(100); // capped
      expect(savedHistory[savedHistory.length - 1].toolName).toBe('new_tool');
    });
  });
});

// ============================================================================
// ApprovalGate - Mode integration
// ============================================================================

describe('ApprovalGate modes', () => {
  let mockManager: any;
  let gate: ApprovalGate;

  beforeEach(() => {
    mockManager = createMockApprovalManager();
    // Empty rules engine - so we can test mode-based threshold
    const engine = new PolicyRulesEngine([]);
    gate = new ApprovalGate(mockManager, engine);
  });

  it('should default to balanced mode', () => {
    expect(gate.getMode()).toBe('balanced');
  });

  it('should allow setting mode', () => {
    gate.setMode('high_speed');
    expect(gate.getMode()).toBe('high_speed');
  });

  it('balanced mode: should ask for score > 30', async () => {
    gate.setMode('balanced');
    const decision = await gate.check('test_tool', {}, makeAssessor(35));
    expect(decision).toBe('auto_approve'); // manager returns approve
    expect(mockManager.requestApproval).toHaveBeenCalled();
  });

  it('balanced mode: should auto-approve for score <= 30', async () => {
    gate.setMode('balanced');
    const decision = await gate.check('test_tool', {}, makeAssessor(25));
    expect(decision).toBe('auto_approve');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
  });

  it('high_speed mode: should ask for score > 60', async () => {
    gate.setMode('high_speed');
    const decision = await gate.check('test_tool', {}, makeAssessor(65));
    expect(decision).toBe('auto_approve'); // manager returns approve
    expect(mockManager.requestApproval).toHaveBeenCalled();
  });

  it('high_speed mode: should auto-approve for score <= 60', async () => {
    gate.setMode('high_speed');
    const decision = await gate.check('test_tool', {}, makeAssessor(50));
    expect(decision).toBe('auto_approve');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
  });

  it('yolo mode: should auto-approve everything', async () => {
    gate.setMode('yolo');
    const decision = await gate.check('test_tool', {}, makeAssessor(90));
    expect(decision).toBe('auto_approve');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
  });
});

// ============================================================================
// ApprovalGate - Trusted/blocked domains
// ============================================================================

describe('ApprovalGate trusted/blocked domains', () => {
  let mockManager: any;
  let gate: ApprovalGate;

  beforeEach(() => {
    mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    gate = new ApprovalGate(mockManager, engine);
  });

  describe('trusted domains', () => {
    it('should auto-approve for trusted domains', async () => {
      gate.setTrustedDomains(['example.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(80),
        { currentDomain: 'example.com' }
      );
      expect(decision).toBe('auto_approve');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });

    it('should match subdomains of trusted domains', async () => {
      gate.setTrustedDomains(['example.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(80),
        { currentDomain: 'app.example.com' }
      );
      expect(decision).toBe('auto_approve');
    });

    it('should not auto-approve for non-trusted domains', async () => {
      gate.setTrustedDomains(['example.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(50),
        { currentDomain: 'other.com' }
      );
      // Should go through normal approval flow
      expect(mockManager.requestApproval).toHaveBeenCalled();
    });
  });

  describe('blocked domains', () => {
    it('should deny for blocked domains', async () => {
      gate.setBlockedDomains(['malicious.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(10),
        { currentDomain: 'malicious.com' }
      );
      expect(decision).toBe('deny');
      expect(mockManager.requestApproval).not.toHaveBeenCalled();
    });

    it('should match subdomains of blocked domains', async () => {
      gate.setBlockedDomains(['malicious.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(10),
        { currentDomain: 'sub.malicious.com' }
      );
      expect(decision).toBe('deny');
    });

    it('should check blocked before trusted', async () => {
      gate.setTrustedDomains(['malicious.com']);
      gate.setBlockedDomains(['malicious.com']);
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(10),
        { currentDomain: 'malicious.com' }
      );
      expect(decision).toBe('deny'); // blocked wins
    });

    it('should not match partial domain suffixes (I3 boundary check)', async () => {
      gate.setBlockedDomains(['bank.com']);
      // "notabank.com" should NOT match "bank.com"
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(10),
        { currentDomain: 'notabank.com' }
      );
      expect(decision).toBe('auto_approve'); // should NOT be denied
    });

    it('should match proper subdomains', async () => {
      gate.setBlockedDomains(['bank.com']);
      // "my.bank.com" SHOULD match "bank.com"
      const decision = await gate.check(
        'dom_tool',
        { action: 'click' },
        makeAssessor(10),
        { currentDomain: 'my.bank.com' }
      );
      expect(decision).toBe('deny');
    });
  });
});

// ============================================================================
// ApprovalGate - History tracking
// ============================================================================

describe('ApprovalGate history tracking', () => {
  let mockManager: any;
  let gate: ApprovalGate;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let configStorage: ApprovalConfigStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    gate = new ApprovalGate(mockManager, engine);

    mockStorage = createMockStorage();
    configStorage = new ApprovalConfigStorage(() => mockStorage);
    gate.setConfigStorage(configStorage);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should record history for auto-approved decisions', async () => {
    await gate.check('planning_tool', {}, makeAssessor(5));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockStorage.set).toHaveBeenCalled();
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('auto_approve');
    expect(history[0].source).toBe('auto');
  });

  it('should record history for user-approved decisions', async () => {
    await gate.check('test_tool', {}, makeAssessor(50));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockStorage.set).toHaveBeenCalled();
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('auto_approve'); // manager returned approve
    expect(history[0].source).toBe('user');
  });

  it('should record history for denied decisions', async () => {
    mockManager.requestApproval.mockResolvedValue({ decision: 'reject', id: 'test' });
    await gate.check('test_tool', {}, makeAssessor(50));
    await vi.advanceTimersByTimeAsync(3000);
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('deny');
    expect(history[0].source).toBe('user');
  });

  it('should record history for blocked domains', async () => {
    gate.setBlockedDomains(['evil.com']);
    await gate.check('dom_tool', {}, makeAssessor(10), { currentDomain: 'evil.com' });
    await vi.advanceTimersByTimeAsync(3000);
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('deny');
    expect(history[0].factors).toContain('Blocked domain');
  });

  it('should record history for trusted domains', async () => {
    gate.setTrustedDomains(['safe.com']);
    await gate.check('dom_tool', {}, makeAssessor(50), { currentDomain: 'safe.com' });
    await vi.advanceTimersByTimeAsync(3000);
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('auto_approve');
    expect(history[0].factors).toContain('Trusted domain');
  });

  it('should record history for YOLO mode', async () => {
    gate.setMode('yolo');
    await gate.check('test_tool', {}, makeAssessor(90));
    await vi.advanceTimersByTimeAsync(3000);
    const history = mockStorage._store['approval_history'];
    expect(history).toHaveLength(1);
    expect(history[0].factors).toContain('YOLO mode');
  });
});

// ============================================================================
// ApprovalGate - Session memory
// ============================================================================

describe('ApprovalGate session memory', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    gate = new ApprovalGate(mockManager, engine);
  });

  it('should remember decisions', () => {
    gate.rememberDecision('terminal', { command: 'ls' }, 'auto_approve');
    expect(gate.getMemorySize()).toBe(1);
  });

  it('should return remembered decision on next check', async () => {
    gate.rememberDecision('terminal', { command: 'ls' }, 'auto_approve');
    const decision = await gate.check('terminal', { command: 'ls' });
    expect(decision).toBe('auto_approve');
  });

  it('should clear memory', () => {
    gate.rememberDecision('terminal', { command: 'ls' }, 'auto_approve');
    expect(gate.getMemorySize()).toBe(1);
    gate.clearMemory();
    expect(gate.getMemorySize()).toBe(0);
  });

  it('should match same tool+action regardless of other parameters', async () => {
    gate.rememberDecision('dom_tool', { action: 'click', node_id: '0:42' }, 'auto_approve');
    // Same tool+action with different node_id should still match (key is toolName||action)
    const decision = await gate.check('dom_tool', { action: 'click', node_id: '0:99' });
    expect(decision).toBe('auto_approve');
  });

  it('should not match different actions', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gateWithManager = new ApprovalGate(mockManager, engine);

    gateWithManager.rememberDecision('dom_tool', { action: 'click' }, 'auto_approve');
    // Different action should NOT match memory
    await gateWithManager.check('dom_tool', { action: 'type' }, makeAssessor(5));
    // Should go through pipeline (no memory hit), but auto-approve via low score
    expect(gateWithManager.getMemorySize()).toBe(1);
  });
});

// ============================================================================
// ApprovalGate - Exact threshold boundaries
// ============================================================================

describe('ApprovalGate threshold boundaries', () => {
  let mockManager: any;

  beforeEach(() => {
    mockManager = createMockApprovalManager();
  });

  it('balanced mode: score exactly 30 should auto-approve', async () => {
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);
    gate.setMode('balanced');
    const decision = await gate.check('test_tool', {}, makeAssessor(30));
    expect(decision).toBe('auto_approve');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
  });

  it('balanced mode: score exactly 31 should ask', async () => {
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);
    gate.setMode('balanced');
    const decision = await gate.check('test_tool', {}, makeAssessor(31));
    expect(mockManager.requestApproval).toHaveBeenCalled();
  });

  it('high_speed mode: score exactly 60 should auto-approve', async () => {
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);
    gate.setMode('high_speed');
    const decision = await gate.check('test_tool', {}, makeAssessor(60));
    expect(decision).toBe('auto_approve');
    expect(mockManager.requestApproval).not.toHaveBeenCalled();
  });

  it('high_speed mode: score exactly 61 should ask', async () => {
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);
    gate.setMode('high_speed');
    const decision = await gate.check('test_tool', {}, makeAssessor(61));
    expect(mockManager.requestApproval).toHaveBeenCalled();
  });
});

// ============================================================================
// ApprovalGate - Approval request mapping
// ============================================================================

describe('ApprovalGate approval request construction', () => {
  it('should map terminal tool to command type', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('terminal', { command: 'npm install' }, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.type).toBe('command');
  });

  it('should map storage tools to storage_access type', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('local_storage', {}, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.type).toBe('storage_access');
  });

  it('should map network tools to network_access type', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('network_fetch', {}, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.type).toBe('network_access');
  });

  it('should map unknown tools to dangerous_action type', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('dom_tool', { action: 'click' }, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.type).toBe('dangerous_action');
  });

  it('should include risk level in approval request details', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('test_tool', {}, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.details.riskLevel).toBe('medium');
  });

  it('should map RiskLevel.None to low in approval details', async () => {
    const mockManager = createMockApprovalManager();
    // Need a rule or threshold that forces ask_user at low score
    const engine = new PolicyRulesEngine([
      { type: 'ask', match: { riskAbove: 0 }, description: 'Ask everything' },
    ]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('test_tool', {}, makeAssessor(5));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.details.riskLevel).toBe('low'); // 'none' maps to 'low'
  });

  it('should include risk factors in approval request', async () => {
    const mockManager = createMockApprovalManager();
    const engine = new PolicyRulesEngine([]);
    const gate = new ApprovalGate(mockManager, engine);

    await gate.check('test_tool', {}, makeAssessor(50));
    const call = mockManager.requestApproval.mock.calls[0][0];
    expect(call.details.impact).toContain('Score: 50');
  });
});
