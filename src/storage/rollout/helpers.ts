/**
 * Helper functions for RolloutRecorder
 * TTL calculations, cursor serialization, timestamp formatting
 */

import type { IAgentConfigWithStorage, Cursor, ConversationId } from './types';

// ============================================================================
// TTL Configuration
// ============================================================================

/**
 * Default TTL: 60 days in milliseconds
 */
const DEFAULT_TTL_DAYS = 60;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Get default TTL value in milliseconds.
 * @returns 60 days in milliseconds
 */
export function getDefaultTTL(): number {
  return DEFAULT_TTL_DAYS * MILLISECONDS_PER_DAY;
}

/**
 * Calculate expiration timestamp from TTL configuration.
 * @param config - Agent configuration with storage settings
 * @returns Unix timestamp for expiration, or undefined for permanent storage
 */
export function calculateExpiresAt(config?: IAgentConfigWithStorage): number | undefined {
  const ttl = config?.storage?.rolloutTTL;

  // Permanent storage
  if (ttl === 'permanent' || ttl === undefined) {
    return undefined;
  }

  // Custom TTL in days
  const days = typeof ttl === 'number' ? ttl : DEFAULT_TTL_DAYS;
  const milliseconds = days * MILLISECONDS_PER_DAY;
  return Date.now() + milliseconds;
}

/**
 * Check if a rollout has expired.
 * @param expiresAt - Expiration timestamp (undefined = permanent)
 * @returns True if rollout is expired
 */
export function isExpired(expiresAt?: number): boolean {
  if (expiresAt === undefined) {
    return false; // Permanent rollouts never expire
  }
  return Date.now() > expiresAt;
}

// ============================================================================
// Cursor Serialization
// ============================================================================

/**
 * Serialize cursor to string for transport.
 * Format: "timestamp|uuid"
 * @param cursor - Cursor to serialize
 * @returns Serialized cursor string
 */
export function serializeCursor(cursor: Cursor): string {
  return `${cursor.timestamp}|${cursor.id}`;
}

/**
 * Deserialize cursor from string.
 * @param token - Serialized cursor string
 * @returns Parsed cursor or null if invalid
 */
export function deserializeCursor(token: string): Cursor | null {
  const parts = token.split('|');
  if (parts.length !== 2) {
    return null;
  }

  const [timestampStr, id] = parts;
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) {
    return null;
  }

  // Basic UUID validation (format: 8-4-4-4-12)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return null;
  }

  return { timestamp, id };
}

// ============================================================================
// Timestamp Formatting
// ============================================================================

/**
 * Format timestamp to ISO 8601 with milliseconds.
 * Format: YYYY-MM-DDTHH:mm:ss.sssZ
 * @param date - Date to format
 * @returns ISO 8601 formatted string
 */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Get current timestamp as ISO 8601 string.
 * @returns Current timestamp in ISO 8601 format
 */
export function getCurrentTimestamp(): string {
  return formatTimestamp(new Date());
}

// ============================================================================
// UUID Validation
// ============================================================================

/**
 * Validate UUID v4 format.
 * @param uuid - UUID string to validate
 * @returns True if valid UUID v4
 */
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate conversation ID (must be valid UUID).
 * @param sessionId - Conversation ID to validate
 * @returns True if valid
 */
export function isValidConversationId(sessionId: ConversationId): boolean {
  return isValidUUID(sessionId);
}

// ============================================================================
// Error Helpers
// ============================================================================

/**
 * Create an error for invalid conversation ID.
 * @param sessionId - The invalid ID
 * @returns Error object
 */
export function createInvalidIdError(sessionId: string): Error {
  return new Error(`Invalid conversation ID: ${sessionId}. Must be a valid UUID.`);
}

/**
 * Create an error for rollout not found.
 * @param rolloutId - The missing rollout ID
 * @returns Error object
 */
export function createRolloutNotFoundError(rolloutId: string): Error {
  return new Error(`Rollout not found: ${rolloutId}`);
}

/**
 * Create an error for database operations.
 * @param operation - The operation that failed
 * @param reason - The reason for failure
 * @returns Error object
 */
export function createDatabaseError(operation: string, reason: string): Error {
  return new Error(`Database operation failed [${operation}]: ${reason}`);
}
