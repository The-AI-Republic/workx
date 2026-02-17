/**
 * ActiveTurn unit tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActiveTurn } from '../ActiveTurn';
import { TaskKind } from '../types';
import type { RunningTask } from '../types';
import { ReviewDecision } from '../../../protocol/types';

/**
 * Helper to create a mock RunningTask matching the actual interface
 */
function createMockTask(
  kind: TaskKind,
  abortController: AbortController,
  startTime?: number,
): RunningTask {
  return {
    kind,
    abortController,
    task: {} as any, // SessionTask mock
    promise: Promise.resolve(null),
    startTime: startTime ?? Date.now(),
  };
}

describe('ActiveTurn', () => {
  let activeTurn: ActiveTurn;

  beforeEach(() => {
    activeTurn = new ActiveTurn();
  });

  describe('Task Management', () => {
    it('should add and check task existence', () => {
      const taskId = 'task-1';
      const abortController = new AbortController();

      activeTurn.addTask(taskId, createMockTask(TaskKind.Regular, abortController));

      expect(activeTurn.hasTask(taskId)).toBe(true);
    });

    it('should return false for non-existent task', () => {
      expect(activeTurn.hasTask('non-existent')).toBe(false);
    });

    it('should remove task and return isEmpty status', () => {
      const taskId = 'task-1';
      const abortController = new AbortController();

      activeTurn.addTask(taskId, createMockTask(TaskKind.Regular, abortController));

      const isEmpty = activeTurn.removeTask(taskId);

      expect(isEmpty).toBe(true);
      expect(activeTurn.hasTask(taskId)).toBe(false);
    });

    it('should handle multiple tasks', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();

      activeTurn.addTask('task-1', createMockTask(TaskKind.Regular, ac1));
      activeTurn.addTask('task-2', createMockTask(TaskKind.Review, ac2));

      expect(activeTurn.hasTask('task-1')).toBe(true);
      expect(activeTurn.hasTask('task-2')).toBe(true);

      const isEmpty1 = activeTurn.removeTask('task-1');
      expect(isEmpty1).toBe(false); // task-2 still exists

      const isEmpty2 = activeTurn.removeTask('task-2');
      expect(isEmpty2).toBe(true); // no tasks left
    });

    it('should return true when removing from empty turn', () => {
      const isEmpty = activeTurn.removeTask('non-existent');
      expect(isEmpty).toBe(true);
    });
  });

  describe('Turn State Delegation', () => {
    it('should delegate pending approval insertion to TurnState', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      const executionId = 'exec-1';

      activeTurn.insertPendingApproval(executionId, resolver);

      const retrieved = activeTurn.removePendingApproval(executionId);
      expect(retrieved).toBe(resolver);
    });

    it('should delegate pending input operations to TurnState', () => {
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      activeTurn.pushPendingInput(input);

      const pending = activeTurn.takePendingInput();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual(input);
    });
  });

  describe('Abort Operations', () => {
    it('should abort all tasks', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();

      const abortSpy1 = vi.spyOn(ac1, 'abort');
      const abortSpy2 = vi.spyOn(ac2, 'abort');

      activeTurn.addTask('task-1', createMockTask(TaskKind.Regular, ac1));
      activeTurn.addTask('task-2', createMockTask(TaskKind.Review, ac2));

      activeTurn.abort();

      expect(abortSpy1).toHaveBeenCalled();
      expect(abortSpy2).toHaveBeenCalled();
      expect(ac1.signal.aborted).toBe(true);
      expect(ac2.signal.aborted).toBe(true);
    });

    it('should handle abort when no tasks exist', () => {
      expect(() => activeTurn.abort()).not.toThrow();
    });

    it('should clear pending approvals and input on abort', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      activeTurn.insertPendingApproval('exec-1', resolver);
      activeTurn.pushPendingInput(input);

      activeTurn.abort();

      const pendingApproval = activeTurn.removePendingApproval('exec-1');
      const pendingInput = activeTurn.takePendingInput();

      expect(pendingApproval).toBeUndefined();
      expect(pendingInput).toEqual([]);
    });
  });

  describe('Drain Operations', () => {
    it('should drain and return all tasks', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();

      activeTurn.addTask('task-1', createMockTask(TaskKind.Regular, ac1));
      activeTurn.addTask('task-2', createMockTask(TaskKind.Review, ac2));

      const tasks = activeTurn.drain();

      expect(tasks.size).toBe(2);
      expect(tasks.has('task-1')).toBe(true);
      expect(tasks.has('task-2')).toBe(true);

      // Verify turn is empty after drain
      expect(activeTurn.hasTask('task-1')).toBe(false);
      expect(activeTurn.hasTask('task-2')).toBe(false);
    });

    it('should return empty map when draining empty turn', () => {
      const tasks = activeTurn.drain();
      expect(tasks.size).toBe(0);
    });

    it('should preserve task details when draining', () => {
      const ac = new AbortController();
      const startTime = Date.now();

      activeTurn.addTask('task-1', createMockTask(TaskKind.Compact, ac, startTime));

      const tasks = activeTurn.drain();
      const drained = tasks.get('task-1');

      expect(drained).toBeDefined();
      expect(drained?.abortController).toBe(ac);
      expect(drained?.kind).toBe(TaskKind.Compact);
      expect(drained?.startTime).toBe(startTime);
    });
  });

  describe('Task Kinds', () => {
    it('should handle Regular tasks', () => {
      const ac = new AbortController();
      activeTurn.addTask('task-1', createMockTask(TaskKind.Regular, ac));
      expect(activeTurn.hasTask('task-1')).toBe(true);
    });

    it('should handle Review tasks', () => {
      const ac = new AbortController();
      activeTurn.addTask('task-1', createMockTask(TaskKind.Review, ac));
      expect(activeTurn.hasTask('task-1')).toBe(true);
    });

    it('should handle Compact tasks', () => {
      const ac = new AbortController();
      activeTurn.addTask('task-1', createMockTask(TaskKind.Compact, ac));
      expect(activeTurn.hasTask('task-1')).toBe(true);
    });
  });
});
