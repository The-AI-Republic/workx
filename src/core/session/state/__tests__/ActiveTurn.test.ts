/**
 * ActiveTurn unit tests
 * Tests must fail until ActiveTurn is implemented (TDD)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActiveTurn } from '../ActiveTurn';
import { TaskKind } from '../types';
import { ReviewDecision } from '../../../protocol/types';

describe('ActiveTurn', () => {
  let activeTurn: ActiveTurn;

  beforeEach(() => {
    activeTurn = new ActiveTurn();
  });

  describe('Task Management', () => {
    it('should add and check task existence', () => {
      const taskId = 'task-1';
      const abortController = new AbortController();

      activeTurn.addTask(taskId, {
        handle: abortController,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: taskId,
      });

      expect(activeTurn.hasTask(taskId)).toBe(true);
    });

    it('should return false for non-existent task', () => {
      expect(activeTurn.hasTask('non-existent')).toBe(false);
    });

    it('should remove task and return isEmpty status', () => {
      const taskId = 'task-1';
      const abortController = new AbortController();

      activeTurn.addTask(taskId, {
        handle: abortController,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: taskId,
      });

      const isEmpty = activeTurn.removeTask(taskId);

      expect(isEmpty).toBe(true);
      expect(activeTurn.hasTask(taskId)).toBe(false);
    });

    it('should handle multiple tasks', () => {
      const task1 = new AbortController();
      const task2 = new AbortController();

      activeTurn.addTask('task-1', {
        handle: task1,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: 'task-1',
      });

      activeTurn.addTask('task-2', {
        handle: task2,
        kind: TaskKind.Review,
        startTime: Date.now(),
        subId: 'task-2',
      });

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
      const task1 = new AbortController();
      const task2 = new AbortController();

      const abortSpy1 = vi.spyOn(task1, 'abort');
      const abortSpy2 = vi.spyOn(task2, 'abort');

      activeTurn.addTask('task-1', {
        handle: task1,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: 'task-1',
      });

      activeTurn.addTask('task-2', {
        handle: task2,
        kind: TaskKind.Review,
        startTime: Date.now(),
        subId: 'task-2',
      });

      activeTurn.abort();

      expect(abortSpy1).toHaveBeenCalled();
      expect(abortSpy2).toHaveBeenCalled();
      expect(task1.signal.aborted).toBe(true);
      expect(task2.signal.aborted).toBe(true);
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
      const task1 = new AbortController();
      const task2 = new AbortController();

      activeTurn.addTask('task-1', {
        handle: task1,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: 'task-1',
      });

      activeTurn.addTask('task-2', {
        handle: task2,
        kind: TaskKind.Review,
        startTime: Date.now(),
        subId: 'task-2',
      });

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
      const task = new AbortController();
      const startTime = Date.now();

      activeTurn.addTask('task-1', {
        handle: task,
        kind: TaskKind.Compact,
        startTime,
        subId: 'sub-1',
      });

      const tasks = activeTurn.drain();
      const drained = tasks.get('task-1');

      expect(drained).toBeDefined();
      expect(drained?.handle).toBe(task);
      expect(drained?.kind).toBe(TaskKind.Compact);
      expect(drained?.startTime).toBe(startTime);
      expect(drained?.subId).toBe('sub-1');
    });
  });

  describe('Task Kinds', () => {
    it('should handle Regular tasks', () => {
      const task = new AbortController();

      activeTurn.addTask('task-1', {
        handle: task,
        kind: TaskKind.Regular,
        startTime: Date.now(),
        subId: 'task-1',
      });

      expect(activeTurn.hasTask('task-1')).toBe(true);
    });

    it('should handle Review tasks', () => {
      const task = new AbortController();

      activeTurn.addTask('task-1', {
        handle: task,
        kind: TaskKind.Review,
        startTime: Date.now(),
        subId: 'task-1',
      });

      expect(activeTurn.hasTask('task-1')).toBe(true);
    });

    it('should handle Compact tasks', () => {
      const task = new AbortController();

      activeTurn.addTask('task-1', {
        handle: task,
        kind: TaskKind.Compact,
        startTime: Date.now(),
        subId: 'task-1',
      });

      expect(activeTurn.hasTask('task-1')).toBe(true);
    });
  });
});
