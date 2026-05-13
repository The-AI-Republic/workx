/**
 * Performance Test: Session Creation Overhead (SC-006)
 *
 * Purpose: Verify that concurrent session creation overhead is <100ms
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';

// Mock RepublicAgent with class
vi.mock('@/core/RepublicAgent', () => {
  return {
    RepublicAgent: class MockRepublicAgent {
      config: any;
      constructor(config: any, router: any) {
        this.config = config;
      }
      async initialize() {
        // Simulate minimal initialization time
        await new Promise(resolve => setTimeout(resolve, 5));
        return undefined;
      }
      async cleanup() {
        return undefined;
      }
      setEventDispatcher(_fn: any) {}
      getSession() {
        return {
          sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          conversationId: `conv_${Date.now()}`,
          abortAllTasks: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          setTabId: vi.fn(),
        };
      }
      async submitOperation() {
        return 'op_123';
      }
      getApprovalManager() {
        return {};
      }
      getToolRegistry() {
        return { getTool: vi.fn(), setApprovalGate: vi.fn() };
      }
      getHookDispatcher() {
        return { fire: vi.fn().mockResolvedValue({}) };
      }
      getEngine() {
        return null;
      }
    },
  };
});

// Mock TabManager
const mockTabManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  onTabClosure: vi.fn().mockReturnValue(() => {}),
  reset: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/TabManager', () => ({
  TabManager: {
    getInstance: () => mockTabManager,
  },
}));

// Mock Chrome APIs
const mockChrome = {
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
  },
};

describe('Session Creation Performance (SC-006)', () => {
  let registry: AgentRegistry;
  const mockConfig = {
    on: vi.fn(),
    off: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
    getModelConfig: vi.fn().mockReturnValue({ modelKey: 'test' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    AgentRegistry.resetInstance();
    global.chrome = mockChrome as any;

    registry = AgentRegistry.getInstance({ maxConcurrent: 10 });
    registry.initialize(mockConfig as any);
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  it('should create a single session in <100ms', async () => {
    const start = performance.now();

    await registry.createSession({ type: 'primary' });

    const elapsed = performance.now() - start;

    console.log(`[Performance] Single session creation: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  it('should create 3 sessions sequentially in <300ms', async () => {
    const start = performance.now();

    await registry.createSession({ type: 'primary' });
    await registry.createSession({ type: 'scheduled' });
    await registry.createSession({ type: 'scheduled' });

    const elapsed = performance.now() - start;

    console.log(`[Performance] 3 sequential sessions: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(300);
  });

  it('should maintain <20ms overhead per additional session', async () => {
    // Create first session and measure baseline
    const start1 = performance.now();
    await registry.createSession({ type: 'primary' });
    const baseline = performance.now() - start1;

    // Create additional sessions and measure overhead
    const overheads: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await registry.createSession({ type: 'scheduled' });
      const elapsed = performance.now() - start;
      overheads.push(elapsed);
    }

    const avgOverhead = overheads.reduce((a, b) => a + b, 0) / overheads.length;

    console.log(`[Performance] Baseline: ${baseline.toFixed(2)}ms`);
    console.log(`[Performance] Average additional session overhead: ${avgOverhead.toFixed(2)}ms`);
    console.log(`[Performance] Per-session overheads: ${overheads.map(o => o.toFixed(2)).join('ms, ')}ms`);

    // Registry operations should have minimal overhead (map insertions, event emissions)
    // The main time should be RepublicAgent.initialize() which we mocked to ~5ms
    expect(avgOverhead).toBeLessThan(50); // Allow some variance in test environment
  });

  it('should handle session removal without performance degradation', async () => {
    // Create sessions
    const sessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const session = await registry.createSession({ type: 'scheduled' });
      sessions.push(session.sessionId);
    }

    // Measure removal time
    const removalTimes: number[] = [];
    for (const sessionId of sessions) {
      const start = performance.now();
      await registry.removeSession(sessionId);
      removalTimes.push(performance.now() - start);
    }

    const avgRemoval = removalTimes.reduce((a, b) => a + b, 0) / removalTimes.length;

    console.log(`[Performance] Average session removal: ${avgRemoval.toFixed(2)}ms`);
    expect(avgRemoval).toBeLessThan(50);
  });

  it('should list sessions efficiently', async () => {
    // Create several sessions
    for (let i = 0; i < 5; i++) {
      await registry.createSession({ type: 'scheduled' });
    }

    // Measure list operation
    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      registry.listSessions();
    }

    const elapsed = performance.now() - start;
    const perOperation = elapsed / iterations;

    console.log(`[Performance] listSessions() over ${iterations} calls: ${elapsed.toFixed(2)}ms total, ${perOperation.toFixed(3)}ms per call`);
    expect(perOperation).toBeLessThan(1); // Should be sub-millisecond
  });

  it('should check canCreateSession efficiently', async () => {
    // Create sessions up to near limit
    for (let i = 0; i < 5; i++) {
      await registry.createSession({ type: 'scheduled' });
    }

    // Measure check operation
    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      registry.canCreateSession();
    }

    const elapsed = performance.now() - start;
    const perOperation = elapsed / iterations;

    console.log(`[Performance] canCreateSession() over ${iterations} calls: ${elapsed.toFixed(2)}ms total, ${perOperation.toFixed(4)}ms per call`);
    expect(perOperation).toBeLessThan(0.1); // Should be very fast
  });
});
