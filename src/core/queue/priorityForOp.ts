// File: src/core/queue/priorityForOp.ts
//
// Track 08 — EngineOp → QueuePriority mapping
//
// Centralized so a new EngineOp variant either gets an explicit case or
// falls through to the safe 'next' default. Adding a new variant should
// be accompanied by a case here and an assertion in priorityForOp.test.ts.

import type { EngineOp } from '../engine/RepublicAgentEngineConfig';
import type { QueuePriority } from './types';

/**
 * Map an EngineOp to its default queue priority.
 *
 * - 'now': user is actively waiting; must not sit behind queued background ops.
 *   Interrupt, Shutdown, and approval responses fall here.
 * - 'next': ordinary foreground submissions.
 * - 'later': background work that can wait for foreground to settle.
 */
export function priorityForOp(op: EngineOp): QueuePriority {
  switch (op.type) {
    case 'Interrupt':
    case 'Shutdown':
    case 'ExecApproval':
    case 'PatchApproval':
      return 'now';
    case 'Compact':
    case 'AddToHistory':
      return 'later';
    // UserInput, UserTurn, ManualCompact, ClearHistory, and any future
    // op type fall through to 'next' — the safe default for foreground
    // submissions.
    default:
      return 'next';
  }
}
