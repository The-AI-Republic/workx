/**
 * TurnState unit tests
 * Tests must fail until TurnState is implemented (TDD)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnState } from '../TurnState';
import { ReviewDecision } from '../../../protocol/types';
import type { ApprovalResolver } from '../types';

describe('TurnState', () => {
  let turnState: TurnState;

  beforeEach(() => {
    turnState = new TurnState();
  });

  describe('Pending Approvals', () => {
    it('should insert and remove pending approval', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      const executionId = 'exec-1';

      // Insert approval
      turnState.insertPendingApproval(executionId, resolver);

      // Remove approval
      const retrieved = turnState.removePendingApproval(executionId);

      expect(retrieved).toBeDefined();
      expect(retrieved).toBe(resolver);
    });

    it('should return undefined when removing non-existent approval', () => {
      const result = turnState.removePendingApproval('non-existent');
      expect(result).toBeUndefined();
    });

    it('should allow multiple pending approvals', () => {
      const resolver1 = vi.fn<[ReviewDecision], void>();
      const resolver2 = vi.fn<[ReviewDecision], void>();

      turnState.insertPendingApproval('exec-1', resolver1);
      turnState.insertPendingApproval('exec-2', resolver2);

      const retrieved1 = turnState.removePendingApproval('exec-1');
      const retrieved2 = turnState.removePendingApproval('exec-2');

      expect(retrieved1).toBe(resolver1);
      expect(retrieved2).toBe(resolver2);
    });

    it('should call resolver with decision', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      turnState.insertPendingApproval('exec-1', resolver);

      const retrieved = turnState.removePendingApproval('exec-1');
      retrieved?.('approve');

      expect(resolver).toHaveBeenCalledWith('approve');
      expect(resolver).toHaveBeenCalledTimes(1);
    });

    it('should clear all pending approvals', () => {
      const resolver1 = vi.fn<[ReviewDecision], void>();
      const resolver2 = vi.fn<[ReviewDecision], void>();

      turnState.insertPendingApproval('exec-1', resolver1);
      turnState.insertPendingApproval('exec-2', resolver2);

      turnState.clearPendingApprovals();

      const retrieved1 = turnState.removePendingApproval('exec-1');
      const retrieved2 = turnState.removePendingApproval('exec-2');

      expect(retrieved1).toBeUndefined();
      expect(retrieved2).toBeUndefined();
    });
  });

  describe('Pending Input', () => {
    it('should push and take pending input', () => {
      const input1 = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Hello' }],
      };
      const input2 = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'World' }],
      };

      turnState.pushPendingInput(input1);
      turnState.pushPendingInput(input2);

      const pending = turnState.takePendingInput();

      expect(pending).toHaveLength(2);
      expect(pending[0]).toEqual(input1);
      expect(pending[1]).toEqual(input2);
    });

    it('should clear pending input after taking', () => {
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      turnState.pushPendingInput(input);
      const first = turnState.takePendingInput();
      const second = turnState.takePendingInput();

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('should return empty array when no pending input', () => {
      const pending = turnState.takePendingInput();
      expect(pending).toEqual([]);
    });

    it('should clear pending input explicitly', () => {
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      turnState.pushPendingInput(input);
      turnState.clearPendingInput();

      const pending = turnState.takePendingInput();
      expect(pending).toEqual([]);
    });

    it('should preserve input order (FIFO)', () => {
      const input1 = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'First' }],
      };
      const input2 = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Second' }],
      };
      const input3 = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Third' }],
      };

      turnState.pushPendingInput(input1);
      turnState.pushPendingInput(input2);
      turnState.pushPendingInput(input3);

      const pending = turnState.takePendingInput();

      expect(pending[0].content[0].text).toBe('First');
      expect(pending[1].content[0].text).toBe('Second');
      expect(pending[2].content[0].text).toBe('Third');
    });
  });

  describe('Combined Operations', () => {
    it('should handle approvals and input independently', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      turnState.insertPendingApproval('exec-1', resolver);
      turnState.pushPendingInput(input);

      const pendingInput = turnState.takePendingInput();
      const pendingApproval = turnState.removePendingApproval('exec-1');

      expect(pendingInput).toHaveLength(1);
      expect(pendingApproval).toBe(resolver);
    });

    it('should clear all state', () => {
      const resolver = vi.fn<[ReviewDecision], void>();
      const input = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Test' }],
      };

      turnState.insertPendingApproval('exec-1', resolver);
      turnState.pushPendingInput(input);

      turnState.clearPendingApprovals();
      turnState.clearPendingInput();

      const pendingInput = turnState.takePendingInput();
      const pendingApproval = turnState.removePendingApproval('exec-1');

      expect(pendingInput).toEqual([]);
      expect(pendingApproval).toBeUndefined();
    });
  });
});
