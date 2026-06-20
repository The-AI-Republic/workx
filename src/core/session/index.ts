/**
 * Public surface for session-level utilities.
 *
 * Track 15 — Conversation Rewind & Fork. `computeRewindSlice` is the shared,
 * UI/transport-independent core API used by all three rewind triggers:
 *   1. ext/desktop  — the `session.rewind` service handler (selector-driven);
 *   2. WorkX Server — the `sessions.rewind` WS RPC (operator-driven);
 *   3. Track 14 / Plan Review — on plan rejection, call
 *      `computeRewindSlice(currentConvId, beginPlanSequence)` and feed the
 *      result into the registry fork seam (`SessionConfig.fork`). Callers
 *      MUST flush the live source session (`Session.flushRollout()`, D13)
 *      before invoking these functions.
 */

export {
  listUserTurns,
  computeRewindSlice,
  buildSummarizedFork,
  findCheckpointSequence,
  pairingTrim,
  type RewindTurn,
  type ForkedHistory,
  type RewindSummarizer,
} from './rewind';
