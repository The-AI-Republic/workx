import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookDispatcher } from '@/core/hooks/HookDispatcher';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import { HookExecutor } from '@/core/hooks/HookExecutor';
import type { HookInput, HookResult } from '@/core/hooks/types';
import type { EventMsg } from '@/core/protocol/events';

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess_1',
    tool_name: 'browser_dom',
    tool_input: { action: 'click' },
    ...overrides,
  };
}

function successResult(hookId = 'h1'): HookResult {
  return { hookId, outcome: 'success', duration: 5 };
}

describe('HookDispatcher', () => {
  let registry: HookRegistry;
  let executor: HookExecutor;
  let dispatcher: HookDispatcher;

  beforeEach(() => {
    registry = new HookRegistry();
    executor = new HookExecutor();
    dispatcher = new HookDispatcher(registry, executor);
  });

  describe('fire — no-hook fast path', () => {
    it('returns empty result when no hooks registered', async () => {
      const result = await dispatcher.fire('PreToolUse', makeInput());
      expect(result.shouldContinue).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(result.totalDuration).toBe(0);
    });

    it('returns empty result when hooks exist but none match', async () => {
      registry.register('PreToolUse', { type: 'command', command: 'echo' }, 'config', 'web_search');
      const result = await dispatcher.fire('PreToolUse', makeInput());
      // The fast-path won't trigger (hasHooksFor is true),
      // but getMatchingHooks filters by tool_name → empty
      expect(result.shouldContinue).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('fire — sync execution', () => {
    it('executes matching hooks and aggregates results', async () => {
      // Spy on executor to return controlled results
      vi.spyOn(executor, 'execute').mockResolvedValue(successResult());

      registry.register('PreToolUse', { type: 'command', command: 'echo' }, 'config');
      const result = await dispatcher.fire('PreToolUse', makeInput());
      expect(result.shouldContinue).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    it('blocks when a hook returns blocking result', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue({
        hookId: 'h1',
        outcome: 'blocking_error',
        stderr: 'Not allowed',
        duration: 3,
      });

      registry.register('PreToolUse', { type: 'command', command: 'check' }, 'config');
      const result = await dispatcher.fire('PreToolUse', makeInput());
      expect(result.shouldContinue).toBe(false);
      expect(result.stopReason).toBe('Not allowed');
    });
  });

  describe('fire — async hooks', () => {
    it('fires async hooks without awaiting', async () => {
      let asyncResolved = false;
      vi.spyOn(executor, 'execute').mockImplementation(async (hook) => {
        if (hook.async) {
          // Simulate slow async hook
          await new Promise((r) => setTimeout(r, 50));
          asyncResolved = true;
        }
        return successResult();
      });

      registry.register('PostToolUse', { type: 'command', command: 'log', async: true }, 'config');
      registry.register('PostToolUse', { type: 'command', command: 'check' }, 'config');

      const result = await dispatcher.fire('PostToolUse', makeInput({ hook_event_name: 'PostToolUse' }));

      // Sync hook executed and returned
      expect(result.results).toHaveLength(1);
      // Async hook may not have resolved yet
      expect(asyncResolved).toBe(false);

      // Wait for async to settle
      await new Promise((r) => setTimeout(r, 100));
      expect(asyncResolved).toBe(true);
    });
  });

  describe('fire — once cleanup', () => {
    it('removes once hooks after firing', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue(successResult());

      registry.register('SessionStart', { type: 'command', command: 'init', once: true }, 'config');
      expect(registry.hasHooksFor('SessionStart')).toBe(true);

      await dispatcher.fire('SessionStart', makeInput({ hook_event_name: 'SessionStart' }));
      expect(registry.hasHooksFor('SessionStart')).toBe(false);
    });

    it('does not remove non-once hooks', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue(successResult());

      registry.register('PostToolUse', { type: 'command', command: 'log' }, 'config');
      await dispatcher.fire('PostToolUse', makeInput({ hook_event_name: 'PostToolUse' }));
      expect(registry.hasHooksFor('PostToolUse')).toBe(true);
    });
  });

  describe('fire — hook failure isolation', () => {
    it('treats executor rejection as non-blocking error result', async () => {
      vi.spyOn(executor, 'execute').mockRejectedValue(new Error('crash'));

      registry.register('PreToolUse', { type: 'command', command: 'bad' }, 'config');

      // allSettled catches the rejection and maps it to a non_blocking_error
      const result = await dispatcher.fire('PreToolUse', makeInput());
      expect(result.shouldContinue).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].outcome).toBe('non_blocking_error');
      expect(result.results[0].stderr).toBe('crash');
    });
  });

  describe('observability events', () => {
    it('emits HookFired event', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue(successResult());

      const events: EventMsg[] = [];
      dispatcher.setEventEmitter((msg) => events.push(msg));

      registry.register('PreToolUse', { type: 'command', command: 'test' }, 'config');
      await dispatcher.fire('PreToolUse', makeInput());

      expect(events.some((e) => e.type === 'HookFired')).toBe(true);
      const fired = events.find((e) => e.type === 'HookFired');
      expect((fired as any).data.hook_event_name).toBe('PreToolUse');
      expect((fired as any).data.hook_count).toBe(1);
    });

    it('emits HookBlocked when execution is blocked', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue({
        hookId: 'h1',
        outcome: 'blocking_error',
        stderr: 'nope',
        duration: 1,
      });

      const events: EventMsg[] = [];
      dispatcher.setEventEmitter((msg) => events.push(msg));

      registry.register('PreToolUse', { type: 'command', command: 'block' }, 'config');
      await dispatcher.fire('PreToolUse', makeInput());

      expect(events.some((e) => e.type === 'HookBlocked')).toBe(true);
    });

    it('does not emit HookBlocked when execution continues', async () => {
      vi.spyOn(executor, 'execute').mockResolvedValue(successResult());

      const events: EventMsg[] = [];
      dispatcher.setEventEmitter((msg) => events.push(msg));

      registry.register('PreToolUse', { type: 'command', command: 'ok' }, 'config');
      await dispatcher.fire('PreToolUse', makeInput());

      expect(events.some((e) => e.type === 'HookBlocked')).toBe(false);
    });
  });

  describe('getRegistry', () => {
    it('returns the underlying registry', () => {
      expect(dispatcher.getRegistry()).toBe(registry);
    });
  });
});
