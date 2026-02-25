/**
 * TTL cleanup for expired rollouts.
 * Delegates to the storage provider via RolloutRecorder singleton.
 */

import { RolloutRecorder } from './RolloutRecorder';

/**
 * Clean up expired rollouts.
 * Deletes rollouts where expiresAt < Date.now(), cascading to rollout_items.
 * Permanent rollouts (expiresAt = undefined) are never deleted.
 * @returns Promise resolving to count of deleted rollouts
 */
export async function cleanupExpired(): Promise<number> {
  const provider = await RolloutRecorder.getProvider();
  return provider.cleanupExpired();
}
