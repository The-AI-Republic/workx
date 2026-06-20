/**
 * TurnState - manages pending approvals and input for a turn
 */

import type { ApprovalResolver } from './types';
import type { InputItem } from '../../protocol/types';

/**
 * Manages pending approvals and input during an active turn
 */
export class TurnState {
  /** Map of execution ID to approval resolver callback */
  private pendingApprovals: Map<string, ApprovalResolver>;

  /** Queue of pending input items (FIFO) */
  private pendingInput: InputItem[];

  constructor() {
    this.pendingApprovals = new Map();
    this.pendingInput = [];
  }

  /**
   * Insert a pending approval resolver
   * @param executionId Unique identifier for the approval
   * @param resolver Callback to resolve the approval
   */
  insertPendingApproval(executionId: string, resolver: ApprovalResolver): void {
    this.pendingApprovals.set(executionId, resolver);
  }

  /**
   * Remove and return a pending approval resolver
   * @param executionId The approval to remove
   * @returns The resolver callback, or undefined if not found
   */
  removePendingApproval(executionId: string): ApprovalResolver | undefined {
    const resolver = this.pendingApprovals.get(executionId);
    if (resolver) {
      this.pendingApprovals.delete(executionId);
    }
    return resolver;
  }

  /**
   * Clear all pending approvals
   */
  clearPendingApprovals(): void {
    this.pendingApprovals.clear();
  }

  rejectPendingApprovals(): void {
    const resolvers = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    for (const resolver of resolvers) {
      resolver('reject');
    }
  }

  /**
   * Push input to the pending input queue
   * @param input Input item to queue
   */
  pushPendingInput(input: InputItem): void {
    this.pendingInput.push(input);
  }

  /**
   * Take all pending input and clear the queue
   * @returns Array of pending input items (FIFO order)
   */
  takePendingInput(): InputItem[] {
    const items = [...this.pendingInput];
    this.pendingInput = [];
    return items;
  }

  /**
   * Clear pending input queue
   */
  clearPendingInput(): void {
    this.pendingInput = [];
  }
}
