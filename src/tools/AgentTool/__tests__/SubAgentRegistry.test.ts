/**
 * Unit tests for SubAgentRegistry
 *
 * Covers:
 * - register(): success, concurrency enforcement, inline active count, custom maxConcurrent
 * - unregister(): removal, no-op for unknown runId
 * - get(): lookup by runId, undefined for unknown
 * - getActive(): filters only 'running' agents
 * - getAll(): returns all agents regardless of status
 * - canSpawn(): limit checking
 * - updateStatus(): status mutation, no-op for unknown
 * - cancelAll(): dispose, status update, registry clearing, error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubAgentRegistry, type ActiveSubAgent } from '../SubAgentRegistry';
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEngine(): RepublicAgentEngine {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as RepublicAgentEngine;
}

function createAgent(
  overrides: Partial<ActiveSubAgent> = {},
): ActiveSubAgent {
  return {
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? 'test-type',
    description: overrides.description ?? 'test sub-agent',
    parentSessionId: overrides.parentSessionId ?? 'parent-session-1',
    engine: overrides.engine ?? createMockEngine(),
    startTime: overrides.startTime ?? Date.now(),
    status: overrides.status ?? 'running',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentRegistry', () => {
  let registry: SubAgentRegistry;

  beforeEach(() => {
    registry = new SubAgentRegistry();
  });

  // -----------------------------------------------------------------------
  // register()
  // -----------------------------------------------------------------------
  describe('register()', () => {
    it('registers an agent successfully', () => {
      const agent = createAgent({ runId: 'r1' });
      registry.register(agent);

      expect(registry.get('r1')).toBe(agent);
    });

    it('throws when max concurrent running agents reached', () => {
      // Default maxConcurrent is 3 — register 3 running agents
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'running' }));
      registry.register(createAgent({ runId: 'r3', status: 'running' }));

      expect(() =>
        registry.register(createAgent({ runId: 'r4', status: 'running' })),
      ).toThrow('Max concurrent sub-agents (3) reached');
    });

    it('allows registration when some agents are completed (not running)', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'running' }));
      registry.register(createAgent({ runId: 'r3', status: 'running' }));

      // Mark one as completed — frees a slot
      registry.updateStatus('r2', 'completed');

      const agent = createAgent({ runId: 'r4', status: 'running' });
      registry.register(agent);

      expect(registry.get('r4')).toBe(agent);
    });

    it('inline active count check prevents TOCTOU race — counts running agents directly', () => {
      // Register 3 agents but only 1 is running; 2 are completed/failed
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'completed' }));
      registry.register(createAgent({ runId: 'r3', status: 'failed' }));

      // Should succeed: only 1 running agent, well under limit of 3
      const agent = createAgent({ runId: 'r4', status: 'running' });
      registry.register(agent);
      expect(registry.get('r4')).toBe(agent);

      // Now 2 running. Register another.
      registry.register(createAgent({ runId: 'r5', status: 'running' }));
      // 3 running now — next should throw
      expect(() =>
        registry.register(createAgent({ runId: 'r6', status: 'running' })),
      ).toThrow('Max concurrent sub-agents (3) reached');
    });

    it('respects custom maxConcurrent setting', () => {
      const customRegistry = new SubAgentRegistry({ maxConcurrent: 1 });

      customRegistry.register(createAgent({ runId: 'r1', status: 'running' }));

      expect(() =>
        customRegistry.register(createAgent({ runId: 'r2', status: 'running' })),
      ).toThrow('Max concurrent sub-agents (1) reached');
    });

    it('default maxConcurrent is 3', () => {
      // Can register 3 running agents
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'running' }));
      registry.register(createAgent({ runId: 'r3', status: 'running' }));

      // 4th running agent should fail
      expect(() =>
        registry.register(createAgent({ runId: 'r4', status: 'running' })),
      ).toThrow('Max concurrent sub-agents (3) reached');
    });
  });

  // -----------------------------------------------------------------------
  // unregister()
  // -----------------------------------------------------------------------
  describe('unregister()', () => {
    it('removes agent by runId', () => {
      const agent = createAgent({ runId: 'r1' });
      registry.register(agent);
      expect(registry.get('r1')).toBe(agent);

      registry.unregister('r1');
      expect(registry.get('r1')).toBeUndefined();
    });

    it('no-op for non-existent runId', () => {
      // Should not throw
      registry.unregister('does-not-exist');
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------
  describe('get()', () => {
    it('returns agent by runId', () => {
      const agent = createAgent({ runId: 'r1' });
      registry.register(agent);

      expect(registry.get('r1')).toBe(agent);
    });

    it('returns undefined for unknown runId', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getActive()
  // -----------------------------------------------------------------------
  describe('getActive()', () => {
    it('returns only agents with status running', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'running' }));

      const active = registry.getActive();
      expect(active).toHaveLength(2);
      expect(active.every(a => a.status === 'running')).toBe(true);
    });

    it('excludes completed, failed, cancelled agents', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'completed' }));
      registry.register(createAgent({ runId: 'r3', status: 'failed' }));
      registry.register(createAgent({ runId: 'r4', status: 'cancelled' }));

      const active = registry.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].runId).toBe('r1');
    });

    it('returns empty array when no running agents', () => {
      registry.register(createAgent({ runId: 'r1', status: 'completed' }));
      registry.register(createAgent({ runId: 'r2', status: 'failed' }));

      expect(registry.getActive()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAll()
  // -----------------------------------------------------------------------
  describe('getAll()', () => {
    it('returns all agents regardless of status', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'completed' }));
      registry.register(createAgent({ runId: 'r3', status: 'failed' }));
      registry.register(createAgent({ runId: 'r4', status: 'cancelled' }));

      const all = registry.getAll();
      expect(all).toHaveLength(4);

      const runIds = all.map(a => a.runId).sort();
      expect(runIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    });
  });

  // -----------------------------------------------------------------------
  // canSpawn()
  // -----------------------------------------------------------------------
  describe('canSpawn()', () => {
    it('returns true when under limit', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      expect(registry.canSpawn()).toBe(true);
    });

    it('returns false when at limit', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'running' }));
      registry.register(createAgent({ runId: 'r3', status: 'running' }));

      expect(registry.canSpawn()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // updateStatus()
  // -----------------------------------------------------------------------
  describe('updateStatus()', () => {
    it('updates status of existing agent', () => {
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      expect(registry.get('r1')!.status).toBe('running');

      registry.updateStatus('r1', 'completed');
      expect(registry.get('r1')!.status).toBe('completed');
    });

    it('no-op for non-existent runId', () => {
      // Should not throw
      registry.updateStatus('nonexistent', 'failed');

      // Registry remains unaffected
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // cancelAll()
  // -----------------------------------------------------------------------
  describe('cancelAll()', () => {
    it('calls dispose() on all running agents', async () => {
      const engine1 = createMockEngine();
      const engine2 = createMockEngine();
      const engine3 = createMockEngine();

      registry.register(createAgent({ runId: 'r1', status: 'running', engine: engine1 }));
      registry.register(createAgent({ runId: 'r2', status: 'running', engine: engine2 }));
      registry.register(createAgent({ runId: 'r3', status: 'completed', engine: engine3 }));

      await registry.cancelAll();

      // Only running agents get dispose() called
      expect(engine1.dispose).toHaveBeenCalledOnce();
      expect(engine2.dispose).toHaveBeenCalledOnce();
      expect(engine3.dispose).not.toHaveBeenCalled();
    });

    it('sets status to cancelled on running agents', async () => {
      const agent1 = createAgent({ runId: 'r1', status: 'running' });
      const agent2 = createAgent({ runId: 'r2', status: 'running' });

      registry.register(agent1);
      registry.register(agent2);

      await registry.cancelAll();

      // Agent objects have been mutated before clearing
      expect(agent1.status).toBe('cancelled');
      expect(agent2.status).toBe('cancelled');
    });

    it('removes only running entries; preserves historical tombstones', async () => {
      // After the H1 fix, cancelAll deletes only the entries it cancelled —
      // historical (completed/failed/cancelled) tombstones survive so
      // management tools can still report on them.
      registry.register(createAgent({ runId: 'r1', status: 'running' }));
      registry.register(createAgent({ runId: 'r2', status: 'completed' }));

      await registry.cancelAll();

      expect(registry.get('r1')).toBeUndefined();
      expect(registry.get('r2')).toBeDefined();
      expect(registry.get('r2')?.status).toBe('completed');
    });

    it('handles dispose() errors gracefully (reports via onError, not console)', async () => {
      const errors: Array<{ msg: string; err: unknown }> = [];
      const registryWithErrorSink = new SubAgentRegistry({
        maxConcurrent: 5,
        onError: (msg, err) => errors.push({ msg, err }),
      });

      const failingEngine = createMockEngine();
      (failingEngine.dispose as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('dispose boom'),
      );

      const successEngine = createMockEngine();

      registryWithErrorSink.register(createAgent({ runId: 'r1', status: 'running', engine: failingEngine }));
      registryWithErrorSink.register(createAgent({ runId: 'r2', status: 'running', engine: successEngine }));

      // Should NOT throw despite failing dispose
      await expect(registryWithErrorSink.cancelAll()).resolves.toBeUndefined();

      // Both agents had dispose called
      expect(failingEngine.dispose).toHaveBeenCalledOnce();
      expect(successEngine.dispose).toHaveBeenCalledOnce();

      // Error was reported via onError, not console.warn
      expect(errors).toHaveLength(1);
      expect(errors[0].msg).toContain('Error disposing sub-agent r1');
      expect(errors[0].err).toBeInstanceOf(Error);

      // Both running entries are removed (cancelled tombstones kept? No —
      // cancelAll deletes them since they were cancelled by this call)
      expect(registryWithErrorSink.get('r1')).toBeUndefined();
      expect(registryWithErrorSink.get('r2')).toBeUndefined();
    });
  });
});
