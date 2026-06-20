import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TOOL_CONCURRENCY_PROFILE,
  type ToolConcurrencyProfile,
  type ToolRuntimeMetadata,
} from '@/tools/runtimeMetadata';
import { RiskLevel } from '@/core/approval/types';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolDefinition } from '@/tools/BaseTool';
import type { IRiskAssessor } from '@/core/approval/types';

// Helper: create a minimal function tool definition
function makeTool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `Test tool ${name}`,
      strict: false,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const noop = async () => ({ success: true });

describe('DEFAULT_TOOL_CONCURRENCY_PROFILE', () => {
  it('returns false for isConcurrencySafe', () => {
    expect(DEFAULT_TOOL_CONCURRENCY_PROFILE.isConcurrencySafe({})).toBe(false);
  });

  it('returns false for isReadOnly', () => {
    expect(DEFAULT_TOOL_CONCURRENCY_PROFILE.isReadOnly({})).toBe(false);
  });

  it('returns false for isDestructive', () => {
    expect(DEFAULT_TOOL_CONCURRENCY_PROFILE.isDestructive({})).toBe(false);
  });
});

describe('ToolRegistry runtime metadata', () => {
  describe('register() backward compatibility', () => {
    it('accepts bare IRiskAssessor as third argument', async () => {
      const registry = new ToolRegistry();
      const riskAssessor: IRiskAssessor = {
        assess: () => ({ score: 0, level: RiskLevel.None, factors: [], action: 'auto_approve' }),
      };
      await registry.register(makeTool('test'), noop, riskAssessor);
      const gate = { check: vi.fn().mockResolvedValue('auto_approve') } as any;
      registry.setApprovalGate(gate);

      await registry.execute({
        toolName: 'test',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      expect(registry.getTool('test')).not.toBeNull();
      expect(gate.check).toHaveBeenCalledWith('test', {}, riskAssessor, {
        sessionId: 's1',
        turnId: 't1',
      }, {
        hookSnapshot: undefined,
      });
    });

    it('accepts ToolRegistrationOptions as third argument', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop, {
        runtime: {
          concurrency: {
            isConcurrencySafe: () => true,
            isReadOnly: () => true,
            isDestructive: () => false,
          },
        },
      });
      expect(registry.isConcurrencySafe('test', {})).toBe(true);
      expect(registry.isReadOnly('test', {})).toBe(true);
    });

    it('accepts no third argument (uses defaults)', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop);
      expect(registry.isConcurrencySafe('test', {})).toBe(false);
      expect(registry.isReadOnly('test', {})).toBe(false);
    });
  });

  describe('fail-closed defaults', () => {
    it('applies fail-closed defaults when no runtime metadata provided', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop);

      expect(registry.isConcurrencySafe('test', {})).toBe(false);
      expect(registry.isReadOnly('test', {})).toBe(false);
      expect(registry.isDestructive('test', {})).toBe(false);
    });

    it('merges partial concurrency overrides with defaults', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop, {
        runtime: {
          concurrency: {
            isConcurrencySafe: () => true,
            // isReadOnly and isDestructive not provided → defaults (false)
          },
        },
      });

      expect(registry.isConcurrencySafe('test', {})).toBe(true);
      expect(registry.isReadOnly('test', {})).toBe(false);
      expect(registry.isDestructive('test', {})).toBe(false);
    });
  });

  describe('query helpers', () => {
    it('returns false for unknown tool', () => {
      const registry = new ToolRegistry();
      expect(registry.isConcurrencySafe('unknown', {})).toBe(false);
      expect(registry.isReadOnly('unknown', {})).toBe(false);
      expect(registry.isDestructive('unknown', {})).toBe(false);
    });

    it('returns null for unknown tool activity description', () => {
      const registry = new ToolRegistry();
      expect(registry.getActivityDescription('unknown', {})).toBeNull();
    });

    it('catches thrown classifier and returns false', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('explosive'), noop, {
        runtime: {
          concurrency: {
            isConcurrencySafe: () => { throw new Error('boom'); },
            isReadOnly: () => { throw new Error('boom'); },
            isDestructive: () => { throw new Error('boom'); },
          },
        },
      });

      expect(registry.isConcurrencySafe('explosive', {})).toBe(false);
      expect(registry.isReadOnly('explosive', {})).toBe(false);
      expect(registry.isDestructive('explosive', {})).toBe(false);
    });

    it('returns activity description when provided', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop, {
        runtime: {
          ui: {
            getActivityDescription: (input) => `Doing ${input.action}`,
          },
        },
      });

      expect(registry.getActivityDescription('test', { action: 'snapshot' }))
        .toBe('Doing snapshot');
    });

    it('returns result profile when provided', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('test'), noop, {
        runtime: {
          result: { maxResultSizeChars: 50_000 },
        },
      });

      expect(registry.getResultProfile('test')?.maxResultSizeChars).toBe(50_000);
    });
  });

  describe('per-input concurrency classification', () => {
    it('classifies dom_tool snapshot as safe, click as unsafe', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('dom_tool'), noop, {
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => input.action === 'snapshot',
            isReadOnly: (input) => input.action === 'snapshot',
            isDestructive: () => false,
          },
        },
      });

      expect(registry.isConcurrencySafe('dom_tool', { action: 'snapshot' })).toBe(true);
      expect(registry.isReadOnly('dom_tool', { action: 'snapshot' })).toBe(true);
      expect(registry.isConcurrencySafe('dom_tool', { action: 'click' })).toBe(false);
      expect(registry.isReadOnly('dom_tool', { action: 'click' })).toBe(false);
    });

    it('classifies storage_tool read/list as safe, delete as destructive', async () => {
      const READ_ACTIONS = new Set(['read', 'list']);
      const registry = new ToolRegistry();
      await registry.register(makeTool('storage_tool'), noop, {
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => READ_ACTIONS.has(input.action as string),
            isReadOnly: (input) => READ_ACTIONS.has(input.action as string),
            isDestructive: (input) => input.action === 'delete',
          },
        },
      });

      expect(registry.isConcurrencySafe('storage_tool', { action: 'read' })).toBe(true);
      expect(registry.isConcurrencySafe('storage_tool', { action: 'list' })).toBe(true);
      expect(registry.isConcurrencySafe('storage_tool', { action: 'write' })).toBe(false);
      expect(registry.isDestructive('storage_tool', { action: 'delete' })).toBe(true);
      expect(registry.isDestructive('storage_tool', { action: 'read' })).toBe(false);
    });
  });

  describe('result size handling (track 09 — persistence moved to TurnManager)', () => {
    // Track 09 moved size enforcement out of ToolRegistry.execute() into
    // TurnManager (which has session lifecycle and a backing store). The
    // registry now passes tool results through verbatim regardless of
    // declared maxResultSizeChars; that field has become the *threshold*
    // input to the persistence path. The persistence path itself is tested
    // in src/core/__tests__/TurnManager.persistence.test.ts and
    // src/tools/__tests__/resultBudget.test.ts.
    it('does not truncate large string results — passes through unchanged', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('big_tool'), async () => 'x'.repeat(200), {
        runtime: { result: { maxResultSizeChars: 50 } },
      });

      const response = await registry.execute({
        toolName: 'big_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      expect(response.success).toBe(true);
      expect(response.data).toBe('x'.repeat(200));
    });

    it('passes small string results through unchanged', async () => {
      const registry = new ToolRegistry();
      await registry.register(makeTool('small_tool'), async () => 'hello', {
        runtime: { result: { maxResultSizeChars: 1000 } },
      });

      const response = await registry.execute({
        toolName: 'small_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      expect(response.data).toBe('hello');
    });

    it('passes objects through unchanged regardless of size', async () => {
      const registry = new ToolRegistry();
      const bigObject = { items: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(20) })) };
      await registry.register(makeTool('big_object_tool'), async () => bigObject, {
        runtime: { result: { maxResultSizeChars: 200 } },
      });

      const response = await registry.execute({
        toolName: 'big_object_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      expect(response.success).toBe(true);
      expect(response.data).toEqual(bigObject);
    });

    it('leaves non-string results untouched (small)', async () => {
      const registry = new ToolRegistry();
      const obj = { ok: true, value: 42 };
      await registry.register(makeTool('small_object_tool'), async () => obj, {
        runtime: { result: { maxResultSizeChars: 1000 } },
      });

      const response = await registry.execute({
        toolName: 'small_object_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      expect(response.data).toEqual(obj);
    });
  });

  describe('progress event emission', () => {
    it('emits ToolExecutionProgress when onProgress is provided', async () => {
      const events: any[] = [];
      const collector = { collect: (e: any) => events.push(e) };
      const registry = new ToolRegistry(collector);

      await registry.register(makeTool('progress_tool'), async (_params, context) => {
        context.onProgress?.({
          toolUseID: 'p1',
          data: { type: 'test_progress', status: 'running' } as any,
        });
        return 'done';
      });

      const progressEvents: any[] = [];
      await registry.execute({
        toolName: 'progress_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
        callId: 'call_123',
        onProgress: (p) => progressEvents.push(p),
      });

      // Check the caller received the progress callback
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].data.type).toBe('test_progress');

      // Check ToolExecutionProgress event was emitted
      const progressEvt = events.find(e => e.msg?.type === 'ToolExecutionProgress');
      expect(progressEvt).toBeDefined();
      expect(progressEvt.msg.data.call_id).toBe('call_123');
      expect(progressEvt.msg.data.progress_data.type).toBe('test_progress');
    });

    it('uses unique event ids for multiple progress updates in the same execution', async () => {
      const events: any[] = [];
      const collector = { collect: (e: any) => events.push(e) };
      const registry = new ToolRegistry(collector);

      await registry.register(makeTool('multi_progress_tool'), async (_params, context) => {
        context.onProgress?.({
          toolUseID: 'p1',
          data: { type: 'test_progress', status: 'first' } as any,
        });
        context.onProgress?.({
          toolUseID: 'p2',
          data: { type: 'test_progress', status: 'second' } as any,
        });
        return 'done';
      });

      await registry.execute({
        toolName: 'multi_progress_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
        onProgress: () => {},
      });

      const progressEvts = events.filter(e => e.msg?.type === 'ToolExecutionProgress');
      expect(progressEvts).toHaveLength(2);
      expect(new Set(progressEvts.map((e: any) => e.id)).size).toBe(2);
    });

    it('scopes progress event ids by callId so concurrent executions do not collide', async () => {
      const events: any[] = [];
      const collector = { collect: (e: any) => events.push(e) };
      const registry = new ToolRegistry(collector);

      await registry.register(makeTool('concurrent_progress_tool'), async (_params, context) => {
        context.onProgress?.({
          toolUseID: 'p',
          data: { type: 'test_progress' } as any,
        });
        return 'done';
      });

      await Promise.all([
        registry.execute({
          toolName: 'concurrent_progress_tool',
          parameters: {},
          sessionId: 's1',
          turnId: 't1',
          callId: 'call_A',
          onProgress: () => {},
        }),
        registry.execute({
          toolName: 'concurrent_progress_tool',
          parameters: {},
          sessionId: 's1',
          turnId: 't1',
          callId: 'call_B',
          onProgress: () => {},
        }),
      ]);

      const progressEvts = events.filter(e => e.msg?.type === 'ToolExecutionProgress');
      expect(progressEvts).toHaveLength(2);
      const ids = progressEvts.map(e => e.id as string);
      expect(new Set(ids).size).toBe(2);
      expect(ids.some(id => id.includes('call_A'))).toBe(true);
      expect(ids.some(id => id.includes('call_B'))).toBe(true);
    });

    it('does not emit progress events when onProgress is absent', async () => {
      const events: any[] = [];
      const collector = { collect: (e: any) => events.push(e) };
      const registry = new ToolRegistry(collector);

      await registry.register(makeTool('quiet_tool'), async () => 'done');

      await registry.execute({
        toolName: 'quiet_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
      });

      const progressEvts = events.filter(e => e.msg?.type === 'ToolExecutionProgress');
      expect(progressEvts).toHaveLength(0);
    });
  });

  describe('call_id in lifecycle events', () => {
    it('includes call_id in ToolExecutionStart and ToolExecutionEnd', async () => {
      const events: any[] = [];
      const collector = { collect: (e: any) => events.push(e) };
      const registry = new ToolRegistry(collector);

      await registry.register(makeTool('id_tool'), async () => 'ok');

      await registry.execute({
        toolName: 'id_tool',
        parameters: {},
        sessionId: 's1',
        turnId: 't1',
        callId: 'call_456',
      });

      const start = events.find(e => e.msg?.type === 'ToolExecutionStart');
      const end = events.find(e => e.msg?.type === 'ToolExecutionEnd');

      expect(start?.msg.data.call_id).toBe('call_456');
      expect(end?.msg.data.call_id).toBe('call_456');
    });
  });
});
