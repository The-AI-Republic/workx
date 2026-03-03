/**
 * Owner Identity Verification
 *
 * Verifies whether an inbound message sender is the owner
 * using the static whitelist in config.
 *
 * @module server/plugins/owner-verify
 */

import type { ServerConfig } from '../config/server-config';

/**
 * Check if a platform user ID matches the owner's identity
 * for a given channel type.
 *
 * @param channelType - Plugin/channel type (e.g., 'slack', 'telegram')
 * @param platformUserId - The sender's platform-specific user ID
 * @param config - Server configuration
 * @returns true if the sender is the owner
 */
export function verifyOwner(
  channelType: string,
  platformUserId: string,
  config: ServerConfig
): boolean {
  const identities = config.owner?.identities;
  if (!identities) return false;

  const ownerIds = identities[channelType];
  if (!ownerIds || !Array.isArray(ownerIds)) return false;

  return ownerIds.includes(platformUserId);
}

/**
 * Get all owner identities for a channel type.
 */
export function getOwnerIdentities(
  channelType: string,
  config: ServerConfig
): string[] {
  const identities = config.owner?.identities;
  if (!identities) return [];
  return identities[channelType] ?? [];
}
