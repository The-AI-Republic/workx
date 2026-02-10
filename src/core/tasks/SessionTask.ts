/**
 * SessionTask Interface
 *
 * Defines the contract for task execution in the BrowserxAgent system.
 */

import type { Session } from '../Session';
import type { TurnContext } from '../TurnContext';
import type { InputItem } from '../protocol/types';
import type { TaskKind } from '../session/state/types';

/**
 * SessionTask interface
 * All task implementations must implement this interface
 */
export interface SessionTask {
  /**
   * Return the kind of this task
   * Used for tracking and specialized handling
   */
  kind(): TaskKind;

  /**
   * Execute the task
   *
   * @param session - Session context for state access
   * @param context - Turn context for this execution
   * @param subId - Submission ID for tracking
   * @param input - Input items to process
   * @returns Final assistant message or null
   */
  run(
    session: Session,
    context: TurnContext,
    subId: string,
    input: InputItem[]
  ): Promise<string | null>;

  /**
   * Cleanup on abort
   * Called when task is cancelled before completion
   *
   * @param session - Session context
   * @param subId - Submission ID
   */
  abort(session: Session, subId: string): Promise<void>;
}
