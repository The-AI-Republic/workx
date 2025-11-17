/**
 * Custom Error Classes for Session Tab Binding
 */

import { TabInvalidReason } from './session';

/**
 * Error thrown when operations are attempted on an invalid tab
 */
export class TabInvalidError extends Error {
  constructor(
    public readonly tabId: number,
    public readonly reason: TabInvalidReason,
    public readonly sessionId: string
  ) {
    super(`Tab ${tabId} is ${reason} (session: ${sessionId})`);
    this.name = 'TabInvalidError';

    // Maintain proper stack trace for where error was thrown (V8 engines only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TabInvalidError);
    }
  }
}

/**
 * Error thrown when tab creation fails
 */
export class TabCreationError extends Error {
  constructor(
    message: string,
    public readonly sessionId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TabCreationError';

    // Maintain proper stack trace for where error was thrown (V8 engines only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TabCreationError);
    }
  }
}
